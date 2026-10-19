/**
 * phone-remote — Host half.
 *
 * 1. On activation: mint the authenticated launch URL (webApp advertised root
 *    + connection token), write it to `linkFile`, and push it once so the phone
 *    always has a fresh door.
 * 2. Watch `api-session/status`: when the last running session goes idle,
 *    push "任务跑完了" after a short debounce. Errors push immediately.
 *
 * 通知里的链接（10-19 老板定）：**一律走公网**。发通知前先看有没有还够用的
 * 临时门（`door-state.json`），不够就自动开一扇 30 分钟的（`--quiet`，不额外
 * 推消息），把公网地址放进通知；门到 30 分钟自动关。这样人在外面点通知就能
 * 直接打开界面，不用先手动开门、也不用分辨内网/公网。
 * 门没开成时宁可不给链接（附一句说明），绝不推一条点不开的死链接。
 *
 * 旧行为（仅家里 WiFi 能点的内网链接）已废弃：内网地址在公网不存在，
 * 出门点它必然打不开——这是 10-19 的投诉根因。
 *
 * Notification backend: 企业微信群机器人（wecomWebhook，复用投研 P2 通道）为主，
 * ntfy (ntfyEnabled + topic) 为可选备用。
 *
 * Nothing here blocks or alters the agent loop; every push is fire-and-forget
 * with a bounded timeout and logged failures.
 */

const PUSH_TIMEOUT_MS = 10000

import { readFileSync } from 'node:fs'
import { writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'

export const inject = ['webApp', 'connection']

export function apply(ctx, config) {
  const linkFile = config.linkFile
  const ntfyUrl = config.ntfyUrl || 'https://ntfy.sh/'
  const topic = config.topic || ''
  const useNtfy = config.ntfyEnabled === true && !!topic
  const idleDebounceMs = Number(config.idleDebounceMs ?? 15000)
  const mobileBase = (config.mobileBaseUrl || '').trim()

  // —— 公网门相关配置（10-19 加）———————————————————————————————
  // 门脚本与门状态文件默认就放在 linkFile 同目录（本机就是 remote-gateway 那份）。
  const doorScript = (config.doorScript || '').trim() || join(dirname(linkFile), 'temp-door.mjs')
  const doorStateFile = (config.doorStateFile || '').trim() || join(dirname(linkFile), 'door-state.json')
  const doorMinutes = Number(config.doorMinutes ?? 30) // 每次开门给 30 分钟
  const doorMinRemainingMs = Number(config.doorMinRemainingMs ?? 10 * 60 * 1000) // 现成的门剩不到 10 分钟就重开
  const doorOpenTimeoutMs = Number(config.doorOpenTimeoutMs ?? 120000) // 等门开出来的上限

  // 企业微信通道：优先直接给 wecomWebhook；否则从投研那份 push_channels.json
  // 按 wecomChannel(默认 p2) 取，保持"通道地址只有一个真源"，轮换不用改插件。
  // 键名两套都认：wecomWebhook（企微专用）与 pushWebhook（平台无关模板里的写法），
  // 免得照 config.example.yml 抄了却没生效（10-19 修）。
  const channelsFile = (config.wecomChannelsFile || config.pushChannelsFile || '').trim()
  const channelTier = (config.wecomChannel || config.pushChannel || 'p2').trim()
  let wecomWebhook = (config.wecomWebhook || config.pushWebhook || '').trim()
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

  // —— 公网门：读现有 / 必要时自动开一扇 ————————————————————————
  function readDoorRaw() {
    try {
      return JSON.parse(readFileSync(doorStateFile, 'utf8'))
    } catch {
      return null
    }
  }

  /** 现成的门还有效吗？返回 { url, leftMs } 或 null。 */
  function readLiveDoor() {
    const state = readDoorRaw()
    if (!state?.url) return null
    const leftMs = Date.parse(state.expiresAt ?? '') - Date.now()
    if (!Number.isFinite(leftMs) || leftMs <= 0) return null
    return { url: String(state.url), leftMs }
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  /** 起一扇门（安静模式，不推企微），等它写出门状态后返回公网地址。 */
  async function openDoor() {
    const startedAt = Date.now()
    const child = spawn(process.execPath, [doorScript, '--minutes', String(doorMinutes), '--quiet'], {
      cwd: dirname(doorScript),
      windowsHide: true,
      env: {
        ...process.env,
        CLOUDFLARED_PATH: process.env.CLOUDFLARED_PATH || join(dirname(doorScript), 'bin', 'cloudflared.exe'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let exited = false
    child.on('error', () => { exited = true })
    child.on('exit', () => { exited = true })
    child.stdout?.on('data', () => {})
    child.stderr?.on('data', () => {})

    const deadline = Date.now() + doorOpenTimeoutMs
    while (Date.now() < deadline) {
      await sleep(2000)
      const state = readDoorRaw()
      const openedAt = Date.parse(state?.openedAt ?? '')
      const expiresAt = Date.parse(state?.expiresAt ?? '')
      if (state?.url && Number.isFinite(openedAt) && openedAt >= startedAt - 5000 && expiresAt > Date.now()) {
        return String(state.url)
      }
      if (exited) break
    }
    return null
  }

  let doorPromise = null

  /** 要一条公网链接：现成的够用就复用，否则开一扇新的；开不出来返回 null。 */
  async function ensurePublicLink() {
    const existing = readLiveDoor()
    if (existing && existing.leftMs >= doorMinRemainingMs) return existing.url
    if (!doorPromise) {
      doorPromise = (async () => {
        try {
          const url = await openDoor()
          if (!url) ctx.logger?.warn?.('phone-remote: 公网门没开成，本次通知不带链接')
          return url
        } catch (error) {
          ctx.logger?.warn?.('phone-remote: 开公网门异常: ' + String(error?.message ?? error))
          return null
        } finally {
          doorPromise = null
        }
      })()
    }
    return doorPromise
  }

  const running = new Set()
  let idleTimer = null
  let lastLanLink = null

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
      await mkdir(dirname(linkFile), { recursive: true })
      await writeFile(linkFile, link + '\n', 'utf8')

      // 反向代理靠这个文件找到桌面端当前监听口（桌面重启换端口会自动跟上）。
      const upstreamUrl = new URL(base)
      await writeFile(
        join(dirname(linkFile), 'upstream.json'),
        JSON.stringify({ host: upstreamUrl.hostname, port: Number(upstreamUrl.port || (upstreamUrl.protocol === 'https:' ? 443 : 80)) }) + '\n',
        'utf8',
      )

      // 链接内容变了（桌面重启换钥匙/换端口）才提醒一次；提醒里给公网地址。
      if (link !== lastLanLink) {
        lastLanLink = link
        const door = await ensurePublicLink()
        await push(
          '小昭：手机远程入口已更新',
          door ? `点链接直接从公网打开 Harness（公网门 30 分钟内有效）。` : '公网门这次没开成，没带链接；需要时发「开门」给我。',
          door ?? undefined,
        )
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
        void (async () => {
          const door = await ensurePublicLink()
          await push(
            '小昭：任务跑完了',
            door ? '这一轮活干完了，点链接直接看结果（公网门 30 分钟内有效）。' : '这一轮活干完了。公网门这次没开成，需要时发「开门」给我。',
            door ?? undefined,
          )
        })()
      }, idleDebounceMs)
    }
  })

  ctx.on('api-session/error', (sessionId, message) => {
    void (async () => {
      const door = await ensurePublicLink()
      await push(
        '小昭：任务出错了',
        `${String(message ?? '会话报错，请打开界面查看')}${door ? '' : '（公网门这次没开成，没带链接）'}`,
        door ?? undefined,
      )
    })()
  })

  ctx.effect(() => () => {
    if (idleTimer) clearTimeout(idleTimer)
  })
}
