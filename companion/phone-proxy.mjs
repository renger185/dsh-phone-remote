/**
 * phone-proxy — 手机远程入口的常驻反向代理（**带门闸**）。
 *
 * 手机（同一 WiFi，或 Tailscale 组网后任意网络）访问 http://<本机IP>:51130，
 * 本代理把 HTTP 与 WebSocket 原样转发给桌面端 Harness 的 127.0.0.1 监听口，
 * 并把 Host 头改写回 loopback 形式，通过 Harness 的信任检查。
 *
 * 上游地址从同目录 upstream.json 读（由 phone-remote 插件维护），
 * 读不到时用兜底 127.0.0.1:51121。桌面端重启换端口后无需改这里。
 *
 * ── 门闸（10-22 加）────────────────────────────────────────────
 * 背景：原来这里是**裸奔**的 —— 根路径没带 token、也没有登录 cookie 时，
 *   本代理会 302 自动补上**当前有效的 DSH token**（那段续签代码已删除）。
 *   意味着：**只要公网地址还在，扫到的人就能自动拿到进门的钥匙**。
 *   配合"链接里的 token 首次打开会换成 30 天 cookie"，
 *   真正的风险窗口是 **30 天**，不是门开着的那 30 分钟。
 *
 * 现在加一道**门闸**：
 *   · 开门时（temp-door 开门）生成一把**随机门钥匙**，写进 door-state.json；
 *   · 钥匙**跟着门一起过期**（门关了，钥匙就作废），不是跟 DSH 的 30 天 cookie 走；
 *   · 进门必须带**门钥匙**（?gate=...）；
 *   · 没带 → **直接 401，不给续签**（这是本次要堵的口子）。
 *   ⇒ 门关上之后，链接立刻作废；即便 30 天 cookie 还在，没有当前门钥匙也进不来。
 *
 * 本脚本不改动 Harness 本体；进程死掉只影响手机侧访问，桌面不受牵连。
 */
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { gunzipSync, brotliDecompressSync, inflateSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

const LISTEN_PORT = 51130
const HERE = path.dirname(fileURLToPath(import.meta.url))
const UPSTREAM_FILE = path.join(HERE, 'upstream.json')
const DOOR_STATE_FILE = path.join(HERE, 'door-state.json')
const LOG_FILE = path.join(HERE, 'logs', 'phone-proxy.log')
const FALLBACK = { host: '127.0.0.1', port: 51121 }
const UPSTREAM_TTL_MS = 5000

let cachedUpstream = null
let cachedAt = 0

function log(line) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true })
    try {
      if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 2 * 1024 * 1024) {
        fs.renameSync(LOG_FILE, LOG_FILE + '.1')
      }
    } catch {}
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`, 'utf8')
  } catch {
    // 日志失败绝不能带倒主流程，落 stderr 留痕即可
    console.error(line)
  }
}

function readUpstream() {
  const now = Date.now()
  if (cachedUpstream && now - cachedAt < UPSTREAM_TTL_MS) return cachedUpstream
  cachedAt = now
  try {
    const raw = JSON.parse(fs.readFileSync(UPSTREAM_FILE, 'utf8'))
    const host = typeof raw.host === 'string' && raw.host ? raw.host : FALLBACK.host
    const port = Number.isInteger(raw.port) && raw.port > 0 ? raw.port : FALLBACK.port
    cachedUpstream = { host, port }
  } catch {
    cachedUpstream = FALLBACK
  }
  return cachedUpstream
}

// ⛔ 10-22：原来这里的 currentToken()（读 login-link.txt 取 DSH token）
//    它的**旧用途**是"没钥匙就 302 自动补上 token"——那是**给扫到的人开门**
//    （真正的风险口子），已删除。
//    但 DSH 上游**自己**仍然要 token（裸访问上游实测 401），
//    所以 token 还是要用 —— 区别在于**什么时候给**：
//      旧：任何人访问 → 自动 302 给他 token（= 裸奔）
//      新：**只有过了门闸**（带了有效门钥匙）才把 token 注入转发请求
//    ⇒ 门闸是唯一关口，钥匙不对就永远拿不到 token。

/** 从插件维护的 login-link.txt 里取当前有效 DSH token（5 秒缓存，容忍文件写一半）。 */
let cachedToken = null
let cachedTokenAt = 0
function currentToken() {
  const now = Date.now()
  if (cachedToken && now - cachedTokenAt < UPSTREAM_TTL_MS) return cachedToken
  cachedTokenAt = now
  try {
    const text = fs.readFileSync(path.join(HERE, 'login-link.txt'), 'utf8').trim()
    const value = new URL(text).searchParams.get('token')
    cachedToken = value && value.length > 0 ? value : cachedToken
  } catch {
    // 读不到就沿用上次
  }
  return cachedToken
}

/**
 * 把门钥匙参数 ?gate= 从转发给上游的 URL 里**摘掉**。
 *
 * 门钥匙是**本代理**的凭证，上游不认，不该转发过去（还会污染上游日志）。
 * 注意：**不注入 DSH token** —— 实测那条路走不通（见上方"换 cookie 步骤"的踩坑记录）：
 * DSH 的 cookie 名带主机名哈希，代理换了 cookie 浏览器就不会带回来 → 死循环。
 *
 * ⛔ 10-22 22:00 修（**boss那个「Failed to load plugins」的最终根因，是我改坏的**）：
 *   原来这里用 `new URL(path, 'http://localhost')` 解析、再 `searchParams.toString()` 拼回去。
 *   但 DSH 加载前端模块的地址长这样：
 *       /plugins/??@deepseek-ai/dsh-client-modules/client.js&rev=924425de7cfb
 *   那个 `??` 会被 URL 解析器当成「query 的开始」：
 *       pathname = "/plugins/"
 *       search   = "??@deepseek-ai/dsh-client-modules/client.js&rev=..."
 *   重新序列化后变成：
 *       /plugins/?%3F%40deepseek-ai%2Fdsh-client-modules%2Fclient.js=&rev=...
 *   ⇒ **整个 URL 被编码坏** ⇒ DSH 回 400 ⇒ 模块脚本加载失败
 *   ⇒ 前端 `pendingQueue` 里没有 `@deepseek-ai/dsh-client-modules`
 *   ⇒ boot 抛出 `client-modules: HTML did not preload ...`（就是boss截图那一行）。
 *
 *   ⇒ 现在的规矩：**只有 URL 里真的带 `gate=` 时才动它**，其余**原样返回**；
 *     删除也用**纯字符串替换**，绝不用 URL 重新序列化（会把 `??` 这类字符编码掉）。
 */
function stripGateParam(reqUrl) {
  const s = String(reqUrl || '/')
  // 没有 gate 参数 → 一个字符都不动（保护 plugins/??...&rev=... 这类地址）
  if (!/[?&]gate=/.test(s)) return s
  return s
    .replace(/([?&])gate=[^&]*/g, '$1')  // 删 gate=xxx，保留前面那个 ? 或 &
    .replace(/\?&/g, '?')                // 收拾 "?&" → "?"
    .replace(/&&/g, '&')                 // 收拾 "&&" → "&"
    .replace(/[?&]$/, '')                // 去掉尾部孤零零的 ? 或 &
}

// ── 门闸（10-22 加）──────────────────────────────────────────────
// 门状态里带一把随机门钥匙（gateKey）。它**跟着门一起过期**：
// 门关了（expiresAt 过了）→ 钥匙作废；DSH 重启把门带走 → 钥匙同样作废（因为门也没了）。
let cachedGate = null
let cachedGateAt = 0
function currentGate() {
  const now = Date.now()
  if (cachedGate && now - cachedGateAt < UPSTREAM_TTL_MS) return cachedGate
  cachedGateAt = now
  try {
    const state = JSON.parse(fs.readFileSync(DOOR_STATE_FILE, 'utf8'))
    const key = String(state?.gateKey || '').trim()
    const expires = Date.parse(state?.expiresAt ?? '')
    if (key && Number.isFinite(expires) && expires > Date.now()) {
      cachedGate = { key, expiresAt: expires }
    } else {
      cachedGate = null   // 门关了/没门 → 钥匙作废
    }
  } catch {
    cachedGate = null
  }
  return cachedGate
}

/** 时机安全的字符串比较（防时序侧信道）。 */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''), 'utf8')
  const bufB = Buffer.from(String(b ?? ''), 'utf8')
  if (bufA.length !== bufB.length) return false
  return crypto.timingSafeEqual(bufA, bufB)
}

/**
 * 从请求里取出"门钥匙"：优先 ?gate= 参数，其次本代理自己发的 dsh-gate cookie。
 * （cookie 是为了：首次用钥匙放行后，让后续的静态资源/接口请求也带着钥匙，
 *   不必依赖 DSH 那枚 30 天 cookie —— 那枚 cookie 的有效期跟门无关，是风险来源。）
 */
function extractGateKey(reqUrl, req) {
  let fromQuery = ''
  try {
    fromQuery = new URL(reqUrl, 'http://localhost').searchParams.get('gate') || ''
  } catch {
    fromQuery = ''
  }
  if (fromQuery) return fromQuery
  const cookies = String(req.headers.cookie || '')
  const m = /(?:^|;\s*)dsh-gate=([^;]+)/.exec(cookies)
  return m ? decodeURIComponent(m[1]) : ''
}

/**
 * 这个请求准不准进？
 * @returns {{ ok: boolean, reason: string }}
 *
 * 放行条件（**唯一那道关口，所有入口同口径**）：
 *   带了**当前门钥匙**（?gate= 或 dsh-gate cookie）且门没过期 → 放行
 *   其它一律拒绝。
 *
 * ⛔ 原来这里"没钥匙就自动 302 补上当前 token" —— 那是**给扫到的人开门**，
 *    本次就是堵这个口子。现在没钥匙 = 401，谁来都一样。
 */
function checkGate(reqUrl, req) {
  const key = extractGateKey(reqUrl, req)
  if (!key) return { ok: false, reason: '没带门钥匙' }
  const gate = currentGate()
  if (!gate) {
    return { ok: false, reason: '门已关（无有效门钥匙）' }
  }
  if (!safeEqual(key, gate.key)) {
    return { ok: false, reason: '门钥匙不对' }
  }
  return { ok: true, reason: '门钥匙有效' }
}

/**
 * 放行时给浏览器发一枚"门钥匙 cookie"，有效期跟门一致（门关了它就过期）。
 * ⛔ 10-22 16:45 修（boss实测踩到的真问题）：
 *   原来发的是 `SameSite=Lax`。**Lax 的规则是：跨站导航（点链接）会带 cookie，
 *   但页面加载后的子资源请求（JS/CSS/图片/manifest）不携带 cookie**。
 *   而boss是从**企微聊天里点链接**进来的 —— 那是跨站场景：
 *     · 主文档请求 → 带了票 → 放行（302 → 拿到页面）
 *     · 页面里的 /manifest.webmanifest、/*.js、/*.css → **不带票** → 全被 401
 *   ⇒ 结果就是boss看到的：**界面出不来，只在地址栏看到一串字母**
 *     （那是 DSH 的 token 暴露在 302 跳转的 URL 里）。
 *   实测证据（代理日志 08:37）：
 *     「门闸拦下 GET /manifest.webmanifest —— 没带门钥匙」
 *     「门闸拦下 GET / —— 没带门钥匙」
 *
 *   修法：改成 `SameSite=None; Secure` —— **None 允许子资源请求也带票**；
 *   而 None 必须配 Secure（浏览器硬性要求），隧道是 https，条件满足。
 *   （DSH 自己那枚 dsh-auth cookie 是 SameSite=Strict，那是它的事，不归这里管。）
 */
function gateCookieHeader(gate) {
  const maxAge = Math.max(1, Math.floor((gate.expiresAt - Date.now()) / 1000))
  return `dsh-gate=${encodeURIComponent(gate.key)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=None; Secure`
}

/**
 * 把 DSH token 从地址栏抹掉（10-22 16:50 加）。
 *
 * 背景：DSH 只认 `?token=` 这一条换 cookie 的路（实测：Authorization 头 401、
 *   X-Auth-Token 头 401、POST 表单 405，只有 query 参数 303 能换到 cookie），
 *   所以 token **必须**进 URL → 手机地址栏就显示"一串字母"。
 *   （DSH 自己的响应带 `referrer-policy: no-referrer`，token 不会外泄给第三方，
 *   但它会**留在地址栏和浏览历史**里。）
 *
 * 做法：转发 HTML 时在 `</head>` 前插一小段脚本，用 `history.replaceState`
 *   把地址栏换成干净的网址（去掉 token 和门钥匙参数）。
 *   同源页面，脚本能跑；DSH 是 SPA，replaceState 不影响它的路由。
 */
const CLEAN_URL_SCRIPT = `<script>(function(){try{var u=new URL(location.href);var had=0;if(u.searchParams.has('token')){u.searchParams.delete('token');had=1}if(u.searchParams.has('gate')){u.searchParams.delete('gate');had=1}if(had){history.replaceState(null,'',u.toString())}}catch(e){}})();</script>`

function injectCleanUrlScript(upstreamRes, res, outHeaders) {
  const chunks = []
  let size = 0
  let overflow = false
  upstreamRes.on('data', (chunk) => {
    if (overflow) return
    chunks.push(chunk)
    size += chunk.length
    // 上限保护：页面太大就别注入了（DSH 首页约 40KB，正常）
    if (size > 4 * 1024 * 1024) {
      overflow = true
      // ⛔ 10-22 19:35 修：Content-Length 与 Transfer-Encoding **不能同时出现**
      //   （HTTP/1.1 规范）。上游是 chunked 时这两个头一起发会让浏览器/客户端
      //   直接报 `Parse Error: Content-Length can't be present with Transfer-Encoding`
      //   → **页面压根解析不出来**（boss 19:06 截图那个报错就是它的下游症状）。
      //   ⇒ 凡是要设 content-length，就必须先把 transfer-encoding 删掉。
      delete outHeaders['transfer-encoding']
      outHeaders['content-length'] = String(size)
      res.writeHead(upstreamRes.statusCode ?? 200, outHeaders)
      for (const c of chunks) res.write(c)
      res.end()
      upstreamRes.destroy()
    }
  })
  upstreamRes.on('end', () => {
    if (overflow) return
    const raw = Buffer.concat(chunks)
    // ⛔ 双保险（10-22 17:05）：万一上游还是给了压缩流，
    //   **绝不能**把二进制当 UTF-8 文本吐给浏览器（会变成一坨乱码 —— boss实测踩过）。
    //   这里先看有没有 content-encoding；有压缩就先解开，解不开就**原样透传**（不注入）。
    const encoding = String(upstreamRes.headers['content-encoding'] || '').toLowerCase()
    let text
    try {
      if (encoding.includes('gzip')) text = gunzipSync(raw).toString('utf8')
      else if (encoding.includes('br')) text = brotliDecompressSync(raw).toString('utf8')
      else if (encoding.includes('deflate')) text = inflateSync(raw).toString('utf8')
      else text = raw.toString('utf8')
    } catch (error) {
      // 解不开 = 大概率不是文本（别乱改，原样透传）
      log(`注入跳过：响应解不开（encoding=${encoding || 'none'}）——原样透传`)
      const headers2 = { ...outHeaders }
      // ⛔ 同样：两个头不能并存 —— 这里给的是完整 raw，直接设 length、删 chunked
      delete headers2['transfer-encoding']
      headers2['content-length'] = String(raw.length)
      res.writeHead(upstreamRes.statusCode ?? 200, headers2)
      res.end(raw)
      return
    }
    const injected = text.includes('</head>')
      ? text.replace('</head>', `${CLEAN_URL_SCRIPT}</head>`)
      : CLEAN_URL_SCRIPT + text
    const buf = Buffer.from(injected, 'utf8')
    // 内容变了，长度要重算；content-encoding 要去掉（已经是明文了）
    delete outHeaders['content-encoding']
    // ⛔ 10-22 19:35 修：必须删 transfer-encoding，否则与 content-length 冲突
    delete outHeaders['transfer-encoding']
    outHeaders['content-length'] = String(buf.length)
    res.writeHead(upstreamRes.statusCode ?? 200, outHeaders)
    res.end(buf)
  })
  upstreamRes.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' })
    res.end('upstream error')
  })
}

function forwardHeaders(req, upstream) {
  const authority = `${upstream.host}:${upstream.port}`
  const headers = { ...req.headers, host: authority }
  // 浏览器拨的是 51130，上游看到的是 127.0.0.1:<port>。Harness 要求 Origin
  // 与 Host 同权威，所以 Origin 也要一起改写，否则带 Origin 的请求（含
  // WebSocket 握手后的 HTTP 调用）会过不了信任检查。
  if (typeof headers.origin === 'string' && headers.origin.length > 0) {
    headers.origin = `http://${authority}`
  }
  delete headers['x-forwarded-for']
  delete headers['x-forwarded-host']
  // ⛔ 10-22 17:05 修（boss截图反馈"打开是一堆乱码"）：
  //   要改 HTML（注入清地址栏脚本）就**必须拿到明文**。
  //   浏览器会带 `Accept-Encoding: gzip`，上游就会回 gzip 压缩流；
  //   我原来直接把响应体 `toString('utf8')` 当文本处理 →
  //   **把压缩流当 UTF-8 解了** → 页面变成一坨乱码（boss实测截图确认）。
  //   ⇒ 这里把 Accept-Encoding 改成 identity，**让上游回明文**。
  //   代价：HTML 不压缩（DSH 首页约 40KB，局域网/隧道这点体积无所谓）。
  headers['accept-encoding'] = 'identity'
  return headers
}

const server = http.createServer((req, res) => {
  // ── 门闸：所有请求统一在这里把关（10-22 加）────────────────────
  const gate = checkGate(req.url || '/', req)
  if (!gate.ok) {
    log(`门闸拦下 ${req.method} ${String(req.url).slice(0, 120)} —— ${gate.reason}`)
    res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store, no-transform' })
    res.end('phone-proxy: 门关着（或钥匙不对）。等开门通知里的新链接，或在企微发「开门」。')
    return
  }

  // 放行：给浏览器发一枚跟门同生命周期的门钥匙 cookie，
  // 这样后续的静态资源/接口请求不用每次都带 ?gate= 参数。
  // ⚠️ 但**不能在这里直接 setHeader** —— 上游响应回来时是整体 writeHead(upstreamRes.headers)，
  //    会把这里设的头**整个覆盖掉**（实测踩到：上游自带 Set-Cookie，把门钥匙 cookie 冲没了，
  //    导致浏览器第二次访问又没 cookie → 又被 401）。
  //    ⇒ 改成：把门钥匙 cookie **记下来**，等上游响应回来时**追加**到上游的 set-cookie 里。
  const liveGate = currentGate()
  const extraCookie = liveGate ? gateCookieHeader(liveGate) : ''

  // 放行后：如果请求**没带 DSH 的 token、也没有 DSH 的登录 cookie**，
  // 就 302 跳到 /?token=xxx，让**浏览器自己**去跟 DSH 换 cookie
  // （必须让浏览器去换：DSH 的 cookie 名带主机名哈希，代理换会绑错域名，见上方注释）。
  //
  // ⛔ 关键：这是在**门闸放行之后**才做的。
  //    旧逻辑是"任何人访问根路径 → 自动 302 补 token" = 裸奔（本次要堵的口子）。
  //    现在：**没门钥匙 → 前面就被 401 挡掉了，根本走不到这里**。
  const hasDsAuth = req.headers.cookie?.includes('dsh-auth-')
  const hasTokenInUrl = /[?&]token=/.test(String(req.url || ''))
  if (req.method === 'GET' && !hasDsAuth && !hasTokenInUrl) {
    const token = currentToken()
    if (token) {
      // 保留原 query（含门钥匙参数 gate=）——浏览器跳过去还得靠它过门闸
      const original = String(req.url || '/')
      const [pathPart, queryPart] = original.split('?')
      const params = new URLSearchParams(queryPart || '')
      params.set('token', token)
      // ⚠️ 这一步是**代理自己**发的 302（不是上游响应），所以门钥匙 cookie
      //    得**在这里就带上** —— 否则第一跳就丢了票，
      //    浏览器第二跳带着 token 回来时虽能进门，但**没票**，
      //    之后每次访问都要重新点那条带钥匙的链接（等于"免密通行票"没生效）。
      //    cache-control 里也带 no-transform（理由见下方 outHeaders 处的注释）：
      //    Cloudflare 边缘会压缩响应体，压坏了就是boss看到的乱码。
      const headers = {
        location: `${pathPart}?${params.toString()}`,
        'cache-control': 'no-store, no-transform',
      }
      if (extraCookie) headers['set-cookie'] = extraCookie
      res.writeHead(302, headers)
      res.end()
      return
    }
  }

  // ── 门闸放行后的"换 cookie"步骤（10-22 修正）────────────────────
  // ⚠️ 踩坑记录（实测，别改回去）：
  //   我一度改成"代理直接把 DSH token 注入转发请求"，**结果死循环**。
  //   原因：DSH 的登录 cookie 名带**主机名哈希**（如 dsh-auth-gh70ot1h979rOMLW_xxx），
  //   而代理为了过 DSH 的信任检查**把 Host 改写成了 127.0.0.1:端口**，
  //   于是 DSH 发出的 cookie 绑在 127.0.0.1 上；浏览器是用公网域名访问的，
  //   **不会把这个 cookie 带回去** → 每跳都是 303 → 死循环（实测跳了 50 次）。
  //
  //   正确做法（就是旧逻辑，只是**加了门闸前置**）：
  //   让**浏览器**自己去跟 DSH 换 cookie（302/303 跳给浏览器跟），
  //   这样 cookie 绑在浏览器真正访问的域名上，就对了。
  //   门闸保证的是：**没带门钥匙的人，压根走不到这一步**。
  const upstream = readUpstream()
  const proxyReq = http.request(
    {
      host: upstream.host,
      port: upstream.port,
      // 摘掉门钥匙参数：那是本代理的凭证，不该传给上游
      path: stripGateParam(req.url || '/'),
      method: req.method,
      headers: forwardHeaders(req, upstream),
    },
    (upstreamRes) => {
      const outHeaders = { ...upstreamRes.headers }
      if (extraCookie) {
        const upstreamCookie = upstreamRes.headers['set-cookie']
        const list = Array.isArray(upstreamCookie) ? upstreamCookie : (upstreamCookie ? [upstreamCookie] : [])
        outHeaders['set-cookie'] = [...list, extraCookie]
      }
      // ⛔ 10-22 17:20 定位到的真凶（boss截图"打开是一坨乱码"）：
      //   现象：本机代理直连是**正常 HTML**，但经公网隧道打开就是**乱码**。
      //   实测（同一个门、同一请求）：
      //     本机 127.0.0.1:51130 → 40285 字节明文、**0 乱码** ✅
      //     公网 trycloudflare    → 5687 字节、gzip 魔数 1f 8b、**2347 个坏字符** ❌
      //   原因：代理已把上游 gzip 解开、改好、删掉 content-encoding，吐的是**明文**；
      //   但 **Cloudflare 边缘又把这段明文压成 gzip**，且按响应里的 content-length
      //   截断/编码 → 产出**坏流** → 浏览器按 gzip 解 → 乱码。
      //   修法：加 `Cache-Control: no-transform` —— HTTP 标准里明确禁止
      //   中间节点改写响应体的指令，Cloudflare 认它。
      {
        const cc = String(outHeaders['cache-control'] || '')
        outHeaders['cache-control'] = cc ? `${cc}, no-transform` : 'no-transform'
      }
      // ── 把 DSH token 从地址栏抹掉（10-22 16:50 加）──────────────────
      // 现象：boss手机地址栏显示"一串字母" = DSH 的 token（DSH 只认 query 参数换 cookie，
      //   所以 token 必须进 URL，见上面的踩坑记录）。
      //   虽然 DSH 自己的响应带 `referrer-policy: no-referrer`（token 不会外泄给第三方），
      //   但它**留在地址栏和浏览历史里** —— 看着乱、也让人误以为那是"网址"。
      // 做法：转发 HTML 时插一段脚本，用 history.replaceState 把地址栏换成干净网址。
      //   （同源页面，脚本能跑；DSH 是 SPA，replaceState 不影响它的路由。）
      const contentType = String(upstreamRes.headers['content-type'] || '')
      if (String(req.method).toUpperCase() === 'GET' && contentType.includes('text/html')) {
        injectCleanUrlScript(upstreamRes, res, outHeaders)
        return
      }
      res.writeHead(upstreamRes.statusCode ?? 502, outHeaders)
      upstreamRes.pipe(res)   // ⛔ 10-22 17:35 修：这行之前被我编辑时弄丢了
                              //    ⇒ 只发了响应头、**没发响应体、也没结束**，
                              //    客户端就一直等到超时（实测每 30 秒一挂）。
      return
    },
  )
  proxyReq.on('error', (error) => {
    log(`http ${req.method} ${req.url} upstream error: ${error.message}`)
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('phone-proxy: upstream unreachable, is the Harness desktop app running?')
  })
  req.pipe(proxyReq)
})

server.on('upgrade', (req, socket, head) => {
  // ── 门闸：WebSocket 握手也必须过（10-22 加）────────────────────
  // ⛔ 漏了这一处 = 门闸形同虚设：普通 HTTP 被挡住，但 WebSocket 能直接连上去。
  const gate = checkGate(req.url || '/', req)
  if (!gate.ok) {
    log(`门闸拦下 upgrade ${String(req.url).slice(0, 120)} —— ${gate.reason}`)
    socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\n\r\n门关着（或钥匙不对）。')
    socket.destroy()
    return
  }
  const upstream = readUpstream()
  const proxyReq = http.request({
    host: upstream.host,
    port: upstream.port,
    path: stripGateParam(req.url || '/'),
    method: req.method,
    headers: forwardHeaders(req, upstream),
  })
  const bail = () => socket.destroy()
  proxyReq.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
    const lines = [`HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage ?? ''}`]
    for (const [name, value] of Object.entries(upstreamRes.headers)) {
      if (Array.isArray(value)) for (const item of value) lines.push(`${name}: ${item}`)
      else if (value !== undefined) lines.push(`${name}: ${value}`)
    }
    socket.write(`${lines.join('\r\n')}\r\n\r\n`)
    if (upstreamHead?.length) socket.write(upstreamHead)
    if (head?.length) upstreamSocket.write(head)
    upstreamSocket.pipe(socket).pipe(upstreamSocket)
    log(`upgrade ok: ${req.url}`)
  })
  proxyReq.on('error', (error) => {
    log(`upgrade ${req.url} upstream error: ${error.message}`)
    bail()
  })
  proxyReq.on('response', () => {
    // 上游没走协议切换，回的是普通响应
    log(`upgrade ${req.url} rejected by upstream (plain response)`)
    bail()
  })
  socket.on('error', bail)
  proxyReq.end()
})

server.listen(LISTEN_PORT, '0.0.0.0', () => {
  log(`phone-proxy listening on 0.0.0.0:${LISTEN_PORT}`)
  console.log(`phone-proxy listening on 0.0.0.0:${LISTEN_PORT}`)
})
