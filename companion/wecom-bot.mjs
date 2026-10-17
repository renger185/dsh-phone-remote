/**
 * wecom-bot — 企业微信「智能机器人」长连接客户端。
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
 */
import AiBot, { generateReqId } from '@wecom/aibot-node-sdk'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CONFIG_FILE = path.join(HERE, 'wecom-bot.json')
const LOG_FILE = path.join(HERE, 'logs', 'wecom-bot.log')

function log(line) {
  const text = `[${new Date().toISOString()}] ${line}`
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true })
    fs.appendFileSync(LOG_FILE, text + '\n', 'utf8')
  } catch {}
  console.log(text)
}

const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))

/** 开临时门，等它拿到公网地址后返回（与企微回调路同一套 temp-door）。 */
function openDoor(minutes) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(HERE, 'temp-door.mjs'), '--minutes', String(minutes)], {
      cwd: HERE,
      windowsHide: true,
      env: { ...process.env, CLOUDFLARED_PATH: process.env.CLOUDFLARED_PATH || path.join(HERE, 'bin', 'cloudflared.exe') },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let settled = false
    const onData = (buf) => {
      const match = /(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/i.exec(buf.toString())
      if (match && !settled) {
        settled = true
        resolve(match[1])
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('error', () => { if (!settled) { settled = true; resolve(null) } })
    setTimeout(() => { if (!settled) { settled = true; resolve(null) } }, 45000)
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

// 保活自检：每 10 分钟记一次链路状态，便于发现静默掉线
setInterval(() => {
  try {
    log('链路自检: isConnected=' + String(client.isConnected))
  } catch (error) {
    log('自检异常: ' + String(error?.message ?? error))
  }
}, 10 * 60 * 1000)
