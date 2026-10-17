/**
 * temp-door — 临时限时门。
 *
 * 开门：在本机起一条 cloudflared 快速隧道（公网 https，Cloudflare 证书），
 *       指向本目录的传达室代理（127.0.0.1:51130），把公网地址推进企微 P2，
 *       到点（默认 30 分钟，可 --minutes 3）自动断掉，链接随即失效。
 * 关门：temp-door --close 立即断掉当前门。
 *
 * 用法：
 *   node temp-door.mjs                 # 开 30 分钟
 *   node temp-door.mjs --minutes 3     # 开 3 分钟
 *   node temp-door.mjs --close         # 立即关
 *
 * 说明：只开一扇门，门开着时公网能扫到这个地址（没有登录钥匙进不去，但能看到登录页），
 *       所以到点必须关——这就是本脚本存在的意义。链路全 TLS。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const STATE_FILE = path.join(HERE, 'door-state.json')
const LOG_FILE = path.join(HERE, 'logs', 'temp-door.log')
// 推送出口：平台无关。优先环境变量 PUSH_WEBHOOK，其次同目录 push.json 的 webhook 字段。
// 例（企业微信）：{ "webhook": "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=<KEY>" }
const PUSH_CONFIG = path.join(HERE, 'push.json')
const PROXY_PORT = 51130

function log(line) {
  const text = `[${new Date().toISOString()}] ${line}`
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true })
    fs.appendFileSync(LOG_FILE, text + '\n', 'utf8')
  } catch {}
  console.log(text)
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
    if (data.errcode !== 0) log(`企微推送失败 errcode=${String(data.errcode)} ${String(data.errmsg ?? '')}`)
    else log('企微推送成功')
  } catch (error) {
    log('企微推送异常: ' + error.message)
  }
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  } catch {
    return null
  }
}

function closeDoor(reason) {
  const state = readState()
  if (!state) {
    log('当前没有开着的门')
    return false
  }
  try {
    process.kill(state.pid)
    log(`已关闭隧道进程 pid=${state.pid}（${reason}）`)
  } catch {
    log(`隧道进程 pid=${state.pid} 已不在（${reason}）`)
  }
  try {
    fs.unlinkSync(STATE_FILE)
  } catch {}
  return true
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

const cloudflared = process.env.CLOUDFLARED_PATH || 'cloudflared'
log(`开门中：指向上游 127.0.0.1:${PROXY_PORT}，时长 ${minutes} 分钟`)

const child = spawn(cloudflared, ['tunnel', '--url', `http://127.0.0.1:${PROXY_PORT}`, '--no-autoupdate'], {
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
})

let settled = false
const fail = (why) => {
  if (settled) return
  settled = true
  log('开门失败: ' + why)
  try { child.kill() } catch {}
  process.exit(1)
}

const onChunk = async (buf) => {
  const text = buf.toString()
  const match = /(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/i.exec(text)
  if (!match || settled) return
  settled = true
  const publicUrl = match[1]
  const expiresAt = new Date(Date.now() + minutes * 60 * 1000)
  const hhmm = expiresAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  fs.writeFileSync(STATE_FILE, JSON.stringify({
    pid: child.pid, url: publicUrl, openedAt: new Date().toISOString(), expiresAt: expiresAt.toISOString(), minutes,
  }, null, 2) + '\n', 'utf8')
  log(`门已开: ${publicUrl}（${hhmm} 自动关）`)
  await wecomPush('小昭：临时远程门已开', `门外可直接用浏览器打开 Harness（本次有效至 ${hhmm}，到点自动关闭）。`, publicUrl)
  setTimeout(() => {
    closeDoor('到点自动关')
    void wecomPush('小昭：临时门已自动关闭', '时限到了，公网入口已断开，那条链接已失效。')
    process.exit(0)
  }, minutes * 60 * 1000)
}

child.stdout.on('data', onChunk)
child.stderr.on('data', onChunk)
child.on('error', (error) => fail(error.message))
child.on('exit', (code) => {
  if (!settled) fail(`cloudflared 提前退出 code=${String(code)}`)
})
setTimeout(() => {
  if (!settled) fail('60 秒内没拿到公网地址')
}, 60000)
