/**
 * phone-remote — Host half.
 *
 * 1. On activation: mint the authenticated launch URL (webApp advertised root
 *    + connection token), write it to `linkFile`, and push it once so the phone
 *    always has a fresh door.
 * 2. Watch `api-session/status`: when the last running session goes idle,
 *    push "任务跑完了" after a short debounce. Errors push immediately.
 *
 * Notification backend: 企业微信群机器人 (wecomWebhook, 复用投研 P2 通道) 为主,
 * ntfy (ntfyEnabled + topic) 为可选备用。
 *
 * Nothing here blocks or alters the agent loop; every push is fire-and-forget
 * with a bounded timeout and logged failures.
 */

const PUSH_TIMEOUT_MS = 10000

import { readFileSync } from 'node:fs'

export const inject = ['webApp', 'connection']

export function apply(ctx, config) {
  const linkFile = config.linkFile
  const ntfyUrl = config.ntfyUrl || 'https://ntfy.sh/'
  const topic = config.topic || ''
  const useNtfy = config.ntfyEnabled === true && !!topic
  const idleDebounceMs = Number(config.idleDebounceMs ?? 15000)
  const mobileBase = (config.mobileBaseUrl || '').trim()

  // 企业微信通道：优先直接给 wecomWebhook；否则从投研那份 push_channels.json
  // 按 wecomChannel(默认 p2) 取，保持"通道地址只有一个真源"，轮换不用改插件。
  const channelsFile = (config.wecomChannelsFile || '').trim()
  const channelTier = (config.wecomChannel || 'p2').trim()
  let wecomWebhook = (config.wecomWebhook || '').trim()
  if (!wecomWebhook && channelsFile) {
    try {
      const map = JSON.parse(readFileSync(channelsFile, 'utf8'))
      wecomWebhook = String(map[channelTier] || map.default || '').trim()
    } catch (error) {
      ctx.logger?.warn?.('phone-remote: 读 wecom 通道文件失败: ' + String(error?.message ?? error))
    }
  }

  /** Put the tokenized link under the phone-reachable origin, keep token. */
  function toMobileLink(link) {
    if (!mobileBase) return link
    try {
      const url = new URL(link)
      const target = new URL(mobileBase)
      url.protocol = target.protocol
      url.host = target.host
      return url.toString()
    } catch {
      return link
    }
  }

  const running = new Set()
  let idleTimer = null
  let lastPushedLink = null

  // 企业微信群机器人（复用投研 P2 通道）：markdown 才能带可点跳转。
  async function pushWecom(title, message, link) {
    const text = link
      ? `**${title}**\n${message}\n[点此打开 Harness](${link})`
      : `**${title}**\n${message}`
    const controller = new AbortController()
    const kill = setTimeout(() => controller.abort(), PUSH_TIMEOUT_MS)
    try {
      const response = await fetch(wecomWebhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ msgtype: 'markdown', markdown: { content: text } }),
        signal: controller.signal,
      })
      const data = await response.json().catch(() => ({}))
      if (data.errcode !== 0) {
        ctx.logger?.warn?.(`phone-remote: wecom errcode=${String(data.errcode)} ${String(data.errmsg ?? '')}`)
      }
    } catch (error) {
      ctx.logger?.warn?.('phone-remote: wecom push failed: ' + String(error?.message ?? error))
    } finally {
      clearTimeout(kill)
    }
  }

  // ntfy 备用后端（默认关闭，配 ntfyEnabled: true + topic 才走）。
  async function pushNtfy(title, message, click) {
    const controller = new AbortController()
    const kill = setTimeout(() => controller.abort(), PUSH_TIMEOUT_MS)
    try {
      const payload = { topic, title, message, priority: 3 }
      if (click) payload.click = click
      const response = await fetch(ntfyUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
      if (!response.ok) {
        ctx.logger?.warn?.('phone-remote: ntfy responded ' + response.status)
      }
    } catch (error) {
      ctx.logger?.warn?.('phone-remote: ntfy push failed: ' + String(error?.message ?? error))
    } finally {
      clearTimeout(kill)
    }
  }

  /** 一条通知投递到所有已启用的后端；都没配就什么都不做。 */
  async function push(title, message, link) {
    const jobs = []
    if (wecomWebhook) jobs.push(pushWecom(title, message, link))
    if (useNtfy) jobs.push(pushNtfy(title, message, link))
    await Promise.all(jobs)
  }

  // 1) Login link at activation. The URL carries the process token; the
  // browser exchanges it for a 30-day cookie on first open.
  void (async () => {
    try {
      const base = ctx.webApp.getAdvertisedUrl()
      const link = toMobileLink(ctx.connection.authenticatedUrl(base))
      const { writeFile, mkdir } = await import('node:fs/promises')
      const { dirname, join } = await import('node:path')
      await mkdir(dirname(linkFile), { recursive: true })
      await writeFile(linkFile, link + '\n', 'utf8')

      // 反向代理靠这个文件找到桌面端当前监听口（桌面重启换端口会自动跟上）。
      const upstreamUrl = new URL(base)
      await writeFile(
        join(dirname(linkFile), 'upstream.json'),
        JSON.stringify({ host: upstreamUrl.hostname, port: Number(upstreamUrl.port || (upstreamUrl.protocol === 'https:' ? 443 : 80)) }) + '\n',
        'utf8',
      )

      if (link !== lastPushedLink) {
        lastPushedLink = link
        await push('小昭：手机远程入口已更新', '同一 WiFi 点链接直接打开 Harness；出门用 UU 远程连回桌面。', link)
      }
    } catch (error) {
      ctx.logger?.warn?.('phone-remote: link refresh failed: ' + String(error?.message ?? error))
    }
  })()

  // 2) Session running-state transitions.
  ctx.on('api-session/status', (sessionId, isRunning) => {
    if (isRunning) {
      running.add(sessionId)
      if (idleTimer) {
        clearTimeout(idleTimer)
        idleTimer = null
      }
      return
    }
    running.delete(sessionId)
    if (running.size === 0 && !idleTimer) {
      idleTimer = setTimeout(() => {
        idleTimer = null
        void push('小昭：任务跑完了', '这一轮活干完了，打开手机可以看结果并继续安排。', lastPushedLink ?? undefined)
      }, idleDebounceMs)
    }
  })

  ctx.on('api-session/error', (sessionId, message) => {
    void push('小昭：任务出错了', String(message ?? '会话报错，请打开界面查看'), lastPushedLink ?? undefined)
  })

  ctx.effect(() => () => {
    if (idleTimer) clearTimeout(idleTimer)
  })
}
