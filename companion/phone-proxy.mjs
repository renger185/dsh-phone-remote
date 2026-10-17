/**
 * phone-proxy — 手机远程入口的常驻反向代理。
 *
 * 手机（同一 WiFi，或 Tailscale 组网后任意网络）访问 http://<本机IP>:51130，
 * 本代理把 HTTP 与 WebSocket 原样转发给桌面端 Harness 的 127.0.0.1 监听口，
 * 并把 Host 头改写回 loopback 形式，通过 Harness 的信任检查。
 *
 * 上游地址从同目录 upstream.json 读（由 phone-remote 插件维护），
 * 读不到时用兜底 127.0.0.1:51121。桌面端重启换端口后无需改这里。
 *
 * 本脚本不改动 Harness 本体；进程死掉只影响手机侧访问，桌面不受牵连。
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const LISTEN_PORT = 51130
const HERE = path.dirname(fileURLToPath(import.meta.url))
const UPSTREAM_FILE = path.join(HERE, 'upstream.json')
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

/** 从插件维护的 login-link.txt 里取当前有效 token（5 秒缓存，容忍文件写一半）。 */
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
  return headers
}

const server = http.createServer((req, res) => {
  // 书签直达：根路径没带 token、也没有登录 cookie 时，自动续上当前有效 token。
  // 已有 cookie 就直接放行（哪怕 token 文件短暂过期也不影响已登录的访问）。
  if ((req.url === '/' || req.url === '') && req.method === 'GET' && !req.headers.cookie?.includes('dsh-auth-')) {
    const token = currentToken()
    if (token) {
      res.writeHead(302, { location: `/?token=${token}`, 'cache-control': 'no-store' })
      res.end()
      return
    }
  }
  const upstream = readUpstream()
  const proxyReq = http.request(
    { host: upstream.host, port: upstream.port, path: req.url, method: req.method, headers: forwardHeaders(req, upstream) },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
      upstreamRes.pipe(res)
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
  const upstream = readUpstream()
  const proxyReq = http.request({
    host: upstream.host,
    port: upstream.port,
    path: req.url,
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
