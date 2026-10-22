/**
 * temp-door — 临时限时门【对外发布版 · 平台无关】
 *
 * ⛔⛔ 我是哪一份（10-22 加，防止拿错）：
 *   **本文件 = 对外发布给别人的模板版**（走 PUSH_WEBHOOK / push.json，路径全相对）。
 *   **本机生产真源是另一份**：`<你的数据目录>\<你的工作区>\手机远程插件-dsh-phone-remote\temp-door.mjs`
 *   （走企业微信 p2 通道、通道地址写死在本机）。**本机跑活的是那一份，不是本文件。**
 *   两份是"同功能、不同推送出口"，不是同一份的两个副本。
 *   ⛔ **不要把本文件当成生产脚本去改生产**——改了不生效（生产跑的是上面那个路径）。
 *
 * 开门：在本机起一条 cloudflared 快速隧道（公网 https，Cloudflare 证书），
 *       指向本目录的传达室代理（127.0.0.1:51130），把公网地址推到推送出口，
 *       到点自动断掉，链接随即失效（**脚本自己的默认值 30 分钟**，可用 --minutes 改；
 *       插件自动开门时会显式传 `doorMinutes`，**默认 480 = 8 小时**）。
 * 关门：temp-door --close 立即关掉当前门。
 *
 * 用法：
 *   node temp-door.mjs                 # 开 30 分钟（脚本默认）
 *   node temp-door.mjs --minutes 480   # 开 8 小时（插件自动开门用的就是这个）
 *   node temp-door.mjs --minutes 3     # 开 3 分钟
 *   node temp-door.mjs --close         # 立即关
 *   node temp-door.mjs --quiet         # 只开门、不推消息（调用方自己发链接时用）
 *
 * 说明：只开一扇门。**进门必须带门钥匙**（`?gate=<gateKey>`，开门时随机生成 32 字符）：
 *       只拿到域名访问一律 **401**（连页面内容都不返回）；钥匙正确才放行并下发免密 cookie。
 *       但**拿到完整链接的人在门关之前都能进** —— 这条边界见 `docs/SECURITY.md` 第 2 节。
 *       所以到点必须关——这就是本脚本存在的意义。链路全 TLS。
 *
 * 2026-10 加固（踩坑总结见 docs/PITFALLS.md 第 15 条）：
 *   cloudflared 会**先**打印公网地址、**再**去连边缘节点；连不上时它打印完地址就自己退出。
 *   旧写法"看见地址就算开门成功"会把一条死链推给用户（实测同一台机器约三次里挂一次，
 *   挂的那次 100% 推死链）。现在改成：
 *     ① 必须同时看到"地址" + "Registered tunnel connection"（边缘连接真的注册上了）；
 *     ② 建好后还从公网侧实拨一次，拿到 HTTP 响应（含 302）才算真能用；
 *     ③ 任一条件不满足就自动重试（最多 3 次，间隔 3 秒 / 8 秒）；
 *     ④ 三次都不成 → 只推一句"没开成"，**绝不推死链**；
 *     ⑤ 门开着期间隧道中途断掉，另推一条"门中途断了"；
 *     ⑥ 到点关闭的"门已关闭"提醒必须 await 完再退出（否则会被 process.exit 打断，发不出去）。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const STATE_FILE = path.join(HERE, 'door-state.json')
const LOG_FILE = path.join(HERE, 'logs', 'temp-door.log')
// 推送出口：平台无关。优先环境变量 PUSH_WEBHOOK，其次同目录 push.json 的 webhook 字段。
// 例（企业微信）：{ "webhook": "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=<KEY>" }
const PUSH_CONFIG = path.join(HERE, 'push.json')
const PROXY_PORT = 51130

// 安静模式：只开门，不推消息（插件"任务跑完"通知要的是一条公网链接，由插件自己发，
// 这里再推一条就成了两条通知）。
const QUIET = process.argv.includes('--quiet')

const ATTEMPTS = 3 // 建隧道最多试几次
const ATTEMPT_TIMEOUT_MS = 75000 // 单次尝试的上限（含边缘连接注册）
const RETRY_DELAYS_MS = [3000, 8000] // 两次重试之间的等待
const VERIFY_TRIES = 4 // 推链接前，从公网侧实拨几次
const VERIFY_GAP_MS = 6000

function log(line) {
  const text = `[${new Date().toISOString()}] ${line}`
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true })
    fs.appendFileSync(LOG_FILE, text + '\n', 'utf8')
  } catch {}
  console.log(text)
}

// 10-22 加：运行时自报家门。
// 本机有**两份** temp-door.mjs（本文件=对外发布模板、另一份=本机生产真源），
// 以前光看日志分不出是哪份在跑。现在每条日志行都带身份标记，一眼可辨。
// ⚠ 这里刻意**不写本机路径**（这份是发布给别人的，必须保持脱敏）。
const SCRIPT_ID = '【对外发布模板】'
log(`${SCRIPT_ID} temp-door 启动｜目录=${HERE}｜推送出口=PUSH_WEBHOOK/push.json｜安静模式=${QUIET ? '是' : '否'}`)

// 10-22 加：启动自检 —— 这份是**对外发布模板**，本机跑它是跑错份了。
// 跑错的实际后果（实测）：本文件的门状态写在**自己目录下**的 door-state.json，
//   而生产门状态在**另一个目录** → 跑这份既开不出生产门、也关不掉生产门，
//   还会凭空多一扇"只有它自己知道"的野门。
// 所以这里明确提示，不静默跑偏。
if (fs.existsSync(path.join(HERE, 'phone-proxy.mjs'))) {
  log('⚠ 提醒：本目录里有 phone-proxy.mjs，看着像**本机生产环境**。'
    + '如果你是想开关生产的门，应该跑生产真源那份（不是本文件），否则门会开在本目录、跟生产对不上。')
}

function pushWebhook() {
  const fromEnv = (process.env.PUSH_WEBHOOK || '').trim()
  if (fromEnv) return fromEnv
  try {
    return String(JSON.parse(fs.readFileSync(PUSH_CONFIG, 'utf8')).webhook || '').trim()
  } catch {
    return ''
  }
}

async function wecomPush(title, message, link) {
  if (QUIET) {
    log('（安静模式：本次不推消息，链接由调用方负责发出）')
    return
  }
  const url = pushWebhook()
  if (!url) {
    log('未配置推送地址（PUSH_WEBHOOK 或 push.json），跳过推送')
    return
  }
  const text = link
    ? `**${title}**\n${message}\n[点此打开 Harness](${link})`
    : `**${title}**\n${message}`
  try {
    const controller = new AbortController()
    const kill = setTimeout(() => controller.abort(), 10000)
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ msgtype: 'markdown', markdown: { content: text } }),
      signal: controller.signal,
    })
    const data = await response.json().catch(() => ({}))
    clearTimeout(kill)
    if (data.errcode !== 0) log(`推送失败 errcode=${String(data.errcode)} ${String(data.errmsg ?? '')}`)
    else log('推送成功')
  } catch (error) {
    log('推送异常: ' + error.message)
  }
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  } catch {
    return null
  }
}

function clearState() {
  try {
    fs.unlinkSync(STATE_FILE)
  } catch {}
}

/**
 * 关门。
 * own：本进程自己那条隧道（有就按自己的进程号关）。**必须优先用它**——
 * 门状态文件是"当前那一扇"的公共记录，如果同时存在两扇门（旧进程还没退、又开了一扇），
 * 旧进程到点后按状态文件里的 pid 去关，会把**新门**杀掉。
 */
function closeDoor(reason, own = null) {
  const state = readState()
  const pid = own?.pid ?? state?.pid
  if (!pid) {
    log('当前没有开着的门')
    return false
  }
  try {
    process.kill(pid)
    log(`已关闭隧道进程 pid=${pid}（${reason}）`)
  } catch {
    log(`隧道进程 pid=${pid} 已不在（${reason}）`)
  }
  // 只有当状态文件还属于这一扇门时才删，别把后来那扇门的记录抹掉
  if (!state || String(state.pid) === String(pid)) clearState()
  return true
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 起一条隧道，等"地址 + 边缘连接注册"两样都出现才算成功；早退/超时都算失败。 */
function openOnce() {
  return new Promise((resolve, reject) => {
    const cloudflared = process.env.CLOUDFLARED_PATH || 'cloudflared'
    const child = spawn(cloudflared, ['tunnel', '--url', `http://127.0.0.1:${PROXY_PORT}`, '--no-autoupdate'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let url = null
    let registered = false
    let done = false
    const fail = (why) => {
      if (done) return
      done = true
      try { child.kill() } catch {}
      reject(new Error(why))
    }
    const feed = (buf) => {
      const text = buf.toString()
      if (!url) {
        // 只认隧道地址；把错误信息里的 api.trycloudflare.com 排除掉
        const match = /(https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com)/i.exec(text)
        if (match) url = match[1]
      }
      if (!registered && /Registered tunnel connection/i.test(text)) registered = true
      if (url && registered && !done) {
        done = true
        resolve({ child, url })
      }
    }

    child.stdout.on('data', feed)
    child.stderr.on('data', feed)
    child.on('error', (error) => fail('cloudflared 起不来: ' + String(error?.message ?? error)))
    child.on('exit', (code) => fail(`cloudflared 提前退出 code=${String(code)}（地址出来了但边缘没连上）`))
    setTimeout(() => fail('超时：75 秒内没等到隧道真正连上'), ATTEMPT_TIMEOUT_MS)
  })
}

/** 从公网侧实拨一次，确认这个地址真的能用（不是只在本机有效）。 */
async function verifyPublic(publicUrl) {
  for (let i = 1; i <= VERIFY_TRIES; i++) {
    try {
      const controller = new AbortController()
      const kill = setTimeout(() => controller.abort(), 20000)
      const response = await fetch(publicUrl, { redirect: 'manual', signal: controller.signal })
      clearTimeout(kill)
      log(`公网自测第 ${i} 次：HTTP ${response.status}`)
      if (response.status < 500) return true
    } catch (error) {
      log(`公网自测第 ${i} 次失败: ${error.message}`)
    }
    if (i < VERIFY_TRIES) await sleep(VERIFY_GAP_MS)
  }
  return false
}

const args = process.argv.slice(2)
const minutes = (() => {
  const at = args.indexOf('--minutes')
  if (at === -1) return 30
  const value = Number(args[at + 1])
  return Number.isFinite(value) && value > 0 ? value : 30
})()

if (args.includes('--close')) {
  const closed = closeDoor('手动关门')
  if (closed) await wecomPush('小昭：临时门已关闭', '公网入口已断开，那条链接现在打不开了。')
  process.exit(0)
}

// 已有一扇门开着就先关掉，避免叠门
if (readState()) closeDoor('开门前先清旧的')

let opened = null
for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
  log(`第 ${attempt}/${ATTEMPTS} 次开门中：指向上游 127.0.0.1:${PROXY_PORT}，时长 ${minutes} 分钟`)
  try {
    const handle = await openOnce()
    log('隧道已建立、边缘连接已注册，开始从公网侧自测…')
    if (!(await verifyPublic(handle.url))) {
      try { handle.child.kill() } catch {}
      throw new Error('隧道建起来了，但公网自测拿不到响应')
    }
    log('自测通过（公网可达）')
    opened = handle
    break
  } catch (error) {
    log(`第 ${attempt} 次开门失败: ${error.message}`)
    if (attempt < ATTEMPTS) {
      const wait = RETRY_DELAYS_MS[attempt - 1] ?? 8000
      log(`等 ${Math.round(wait / 1000)} 秒后重试`)
      await sleep(wait)
    }
  }
}

if (!opened) {
  log(`开门失败：试了 ${ATTEMPTS} 次都没成`)
  await wecomPush('小昭：临时门没开成', `试了 ${ATTEMPTS} 次公网隧道都没建立起来，这次没有推链接（省得点开是死的）。稍后可再试一次。`)
  process.exit(1)
}

const { child, url: publicUrl } = opened
const expiresAt = new Date(Date.now() + minutes * 60 * 1000)
const hhmm = expiresAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })

// ── 门钥匙（10-22 加）────────────────────────────────────────────
// 开门时生成一把随机钥匙，写进门状态。传达室（phone-proxy）会校验它：
//   进门必须带这把钥匙（?gate=xxx），**没钥匙一律 401**，不再自动给人续签。
// 钥匙**跟着门一起过期**（expiresAt 一过就作废）。
const gateKey = crypto.randomBytes(24).toString('base64url')

fs.writeFileSync(STATE_FILE, JSON.stringify({
  pid: child.pid, url: publicUrl, openedAt: new Date().toISOString(), expiresAt: expiresAt.toISOString(), minutes,
  gateKey,
}, null, 2) + '\n', 'utf8')
log(`门已开: ${publicUrl}（${hhmm} 自动关）｜门钥匙已生成（${gateKey.length} 字符，有效期跟门一致）`)

// 带钥匙的链接：这是唯一能进门的地址。
// ⚠️ 钥匙在链接里 = 链接泄露 = 钥匙泄露。所以**绝不能**再把不带钥匙的裸地址推给任何人。
const gatedUrl = `${publicUrl}/?gate=${encodeURIComponent(gateKey)}`
await wecomPush('小昭：临时远程门已开', `门外可直接用浏览器打开 Harness（已实测公网可达；本次有效至 ${hhmm}，到点自动关闭）。`, gatedUrl)

let closing = false
child.on('exit', (code) => {
  if (closing) return
  if (Date.now() < expiresAt.getTime()) {
    log(`隧道中途断开 code=${String(code)}，公网入口已失效`)
    clearState()
    void wecomPush('小昭：临时门中途断了', '公网入口掉线了，刚才那条链接现在打不开。要我重开一扇就说一声。')
  }
})

setTimeout(async () => {
  closing = true
  closeDoor('到点自动关', child)
  // 必须等推送发完再退出，否则 fetch 还没发出去进程就没了
  await wecomPush('小昭：临时门已自动关闭', '时限到了，公网入口已断开，那条链接已失效。')
  process.exit(0)
}, minutes * 60 * 1000)
