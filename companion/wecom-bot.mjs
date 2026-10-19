/**
 * wecom-bot — 企业微信「智能机器人」长连接客户端（脱敏示例版）。
 *
 * 为什么用长连接：电脑主动连出去（wss://openws.work.weixin.qq.com），
 * 不需要任何公网地址、不需要企微后台配回调 URL，所以电脑重启/断电都不会失效。
 *
 * 收到文本消息：
 *   - 含「开门」→ 开一扇 30 分钟临时限时门，把链接回进企微会话；
 *   - 其他内容 → 回显确认（把正文喂给 Harness 干活尚未接）。
 *
 * 配置：同目录 wecom-bot.json（botId / secret）。
 * 启动：node wecom-bot.mjs
 *
 * 2026-10 加固（踩坑总结见 docs/PITFALLS.md 第 16 条）：
 *   长连接会"静默假死"——TCP 断了但 SDK 收不到任何事件，进程还活着、任务状态还是 Running，
 *   实际几小时收不到消息（我们实际踩到过 9 小时 20 分钟无人知）。现在：
 *     ① 每分钟自检一次链路；
 *     ② 连续 2 分钟未连接 → 主动重连一次；
 *     ③ 重连后仍连续 5 分钟未连接 → 主动退出，交给保活壳/计划任务重拉一个全新连接；
 *     ④ 在线时每 10 分钟留一条在线记录（判活证据要留痕，不能只留故障）。
 *   另外取开门链接改成"读开门结果文件、且只认刚开的那一扇"：
 *   temp-door 现在会先建隧道再从公网侧自测、自测不过就换一条重来，
 *   从输出里"抓第一个地址"会抓到作废地址。
 */
import AiBot, { generateReqId } from '@wecom/aibot-node-sdk'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CONFIG_FILE = path.join(HERE, 'wecom-bot.json')
const LOG_FILE = path.join(HERE, 'logs', 'wecom-bot.log')
const DOOR_STATE_FILE = path.join(HERE, 'door-state.json')

function log(line) {
  const text = `[${new Date().toISOString()}] ${line}`
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true })
    fs.appendFileSync(LOG_FILE, text + '\n', 'utf8')
  } catch {}
  console.log(text)
}

const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))

/**
 * 开临时门，等它把门开成（写成 door-state.json）后返回公网地址。
 * 不从输出里抓地址：temp-door 会先建隧道、再从公网侧自测，自测不过就换一条重来，
 * 抓早了会把一条可能作废的地址回给用户。
 */
function openDoor(minutes) {
  const startedAt = Date.now()
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(HERE, 'temp-door.mjs'), '--minutes', String(minutes)], {
      cwd: HERE,
      windowsHide: true,
      env: { ...process.env, CLOUDFLARED_PATH: process.env.CLOUDFLARED_PATH || path.join(HERE, 'bin', 'cloudflared.exe') },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const echo = (buf) => { const t = buf.toString().trim(); if (t) log('[temp-door] ' + t) }
    child.stdout.on('data', echo)
    child.stderr.on('data', echo)

    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearInterval(timer)
      resolve(value)
    }

    const timer = setInterval(() => {
      try {
        const text = fs.readFileSync(DOOR_STATE_FILE, 'utf8').replace(/^\uFEFF/, '')
        const state = JSON.parse(text)
        const openedAt = Date.parse(state?.openedAt ?? '')
        if (state?.url && Number.isFinite(openedAt) && openedAt >= startedAt - 5000) finish(state.url)
      } catch {}
    }, 1000)

    child.on('error', () => finish(null))
    child.on('exit', (code) => {
      if (!settled) {
        log(`[temp-door] 开门进程退出 code=${String(code)}，没等到公网地址`)
        finish(null)
      }
    })
    setTimeout(() => finish(null), 90000)
  })
}

const client = new AiBot.WSClient({ botId: config.botId, secret: config.secret })

client.on('authenticated', () => log('✅ 长连接认证成功，机器人已在线（不依赖任何公网地址）'))
client.on('error', (error) => log('连接错误: ' + String(error?.message ?? error)))
client.on('close', () => log('连接已关闭（SDK 会自动重连）'))
client.on('reconnecting', (info) => log('正在重连: ' + JSON.stringify(info ?? {})))

client.on('event.enter_chat', (frame) => {
  try {
    client.replyWelcome(frame, {
      msgtype: 'text',
      text: { content: '我在。\n发「开门」→ 我开一扇 30 分钟的临时远程门，把链接回给你。\n发别的 → 我先回显确认（喂给 Harness 干活还没接）。' },
    })
  } catch (error) {
    log('欢迎语失败: ' + String(error?.message ?? error))
  }
})

client.on('message.text', async (frame) => {
  const content = frame?.body?.text?.content ?? ''
  log(`收到文本: ${JSON.stringify(content)}`)
  const streamId = generateReqId('stream')
  try {
    if (content.includes('开门')) {
      await client.replyStream(frame, streamId, '收到，正在开门…', false)
      const link = await openDoor(30)
      if (link) {
        await client.replyStream(
          frame,
          streamId,
          `**临时门已开（30 分钟）**\n[点此用浏览器打开 Harness](${link})\n到点自动关闭；想提前关就在电脑上双击「临时门-关」。`,
          true,
        )
        log('已回链接: ' + link)
      } else {
        await client.replyStream(frame, streamId, '开门失败，请看电脑上的 `logs\\temp-door.log`。', true)
      }
    } else {
      await client.replyStream(frame, streamId, `收到：${content}\n（长连接通道已通；把正文喂给 Harness 干活还没接）`, true)
    }
  } catch (error) {
    log('回复失败: ' + String(error?.message ?? error))
  }
})

client.connect()
log('机器人启动，正在连接企业微信长连接…')

// 保活自检 + 掉线自愈：见文件头的说明。
const CHECK_INTERVAL_MS = 60 * 1000
const OFFLINE_BEFORE_RECONNECT = 2
const OFFLINE_BEFORE_RESTART = 5
const HEARTBEAT_TICKS = 10

let offlineChecks = 0
let triedReconnect = false
let onlineTicks = 0

setInterval(() => {
  let up = false
  try {
    up = Boolean(client.isConnected)
  } catch (error) {
    log('自检异常: ' + String(error?.message ?? error))
    return
  }

  if (up) {
    if (offlineChecks > 0) log(`链路已恢复（此前连续掉线 ${offlineChecks} 分钟）`)
    offlineChecks = 0
    triedReconnect = false
    onlineTicks += 1
    if (onlineTicks % HEARTBEAT_TICKS === 0) log('链路自检: isConnected=true（在线）')
    return
  }

  offlineChecks += 1
  log(`链路自检: isConnected=false（连续第 ${offlineChecks} 分钟）`)

  if (offlineChecks === OFFLINE_BEFORE_RECONNECT && !triedReconnect) {
    triedReconnect = true
    log(`掉线满 ${OFFLINE_BEFORE_RECONNECT} 分钟，主动发起一次重连…`)
    try {
      client.connect()
    } catch (error) {
      log('主动重连失败: ' + String(error?.message ?? error))
    }
  }

  if (offlineChecks >= OFFLINE_BEFORE_RESTART) {
    log(`连续 ${offlineChecks} 分钟没连上，主动退出，由保活壳重拉一个全新连接`)
    process.exit(1)
  }
}, CHECK_INTERVAL_MS)
