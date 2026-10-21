/**
 * phone-remote — Host half.
 *
 * 1. On activation: mint the authenticated launch URL (webApp advertised root
 *    + connection token), write it to `linkFile`, and push it once so the phone
 *    always has a fresh door.
 * 2. Watch `api-session/status`: when the last running session goes idle,
 *    push "任务跑完了" after a short debounce. Errors push immediately.
 *
 * 通知里的链接（10-19 boss定）：**一律走公网**。发通知前先看有没有还够用的
 * 临时门（`door-state.json`），不够就自动开一扇 30 分钟的（`--quiet`，不额外
 * 推消息），把公网地址放进通知；门到 30 分钟自动关。这样人在外面点通知就能
 * 直接打开界面，不用先手动开门、也不用分辨内网/公网。
 * 门没开成时宁可不给链接（附一句说明），绝不推一条点不开的死链接。
 *
 * 旧行为（仅家里 WiFi 能点的内网链接）已废弃：内网地址在公网不存在，
 * 出门点它必然打不开——这是 10-19 的投诉根因。
 *
 * Notification backend: 企业微信群机器人（wecomWebhook，复用<你的工作区> P2 通道）为主，
 * ntfy (ntfyEnabled + topic) 为可选备用。
 *
 * Nothing here blocks or alters the agent loop; every push is fire-and-forget
 * with a bounded timeout and logged failures.
 */

const PUSH_TIMEOUT_MS = 10000

import { readFileSync, writeFileSync, unlinkSync, statSync, existsSync } from 'node:fs'
import { writeFile, mkdir } from 'node:fs/promises'
import { dirname, join, basename } from 'node:path'
import { spawn } from 'node:child_process'

// 官方消息构造器。⚠️ 不能省：裸对象 {content, source} 投进去，
// 会话的 turnOutline 里 prompt 会是空的（消息没拿到 id、没被登记成轮次）——
// 2026-10-20 实测，话"投进去了"但那一轮什么都跑不出来。
// 官方所有投递点（dsh-schedule/lib/index.js:1586 等）都用它。
// ⚠️ 用动态 import：本插件没在 dependencies 里声明 @deepseek-ai/dsh-llm，
//    万一 host 不给解析，静态 import 会让整个插件加载失败（那是生产事故）。
//    动态 import 失败只损失"消息带 id"，退回裸对象，功能降级但不瘫。
let createUserMessage = null
try {
  ({ createUserMessage } = await import('@deepseek-ai/dsh-llm'))
} catch { /* 解析不到就用兜底 */ }

export const inject = ['webApp', 'connection', 'webServer', 'agents', 'sessionProjections', 'agentDefaultModel', 'sessionController', 'sessions', 'workspaceRegistry']

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

  // 企业微信通道：优先直接给 wecomWebhook；否则从<你的工作区>那份 push_channels.json
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

  // 企业微信群机器人（复用<你的工作区> P2 通道）：markdown 才能带可点跳转。
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

  // ══════════════════════════════════════════════════════════════════════
  // 企微机器人 → <你的工作区>会话（boss 2026-10-20 定：第二批第一步）
  //
  // 链路：手机发消息 → bot\wecom-bot.mjs（长连接）
  //          → HTTP POST 到这个接口（桥）
  //          → 复用<你的工作区>一个**活着的会话**，把话投进去（官方 resolveAgent +
  //            followup，跟定时任务投提醒同一条路）
  //          → 等它跑完 → 结果回给 bot → 回进企微会话
  //
  // ⚠️ 为什么复用而不是新建（2026-10-20 实测，四种方法全试过全失败）：
  //    ctx.agents.create() 建的会话**拿不到工具**——preset=null、工具仅 253 token
  //    （正常会话 12373），AI 自述"没有命令/文件读写工具"。试过：
  //     ① setup 里 await agentPresets.select() → 卡死，模型一次不跑
  //        （llmMs=0 / token 0 / 无报错，"开成了"但一个字不出）
  //     ② setup 里 fire-and-forget → 不卡，但 preset 仍 null
  //     ③ session.append('agent-preset/selected') → 无效
  //     ④ create 时传 agentPreset: 'standard' → 仍无效
  //    硬证据：让它"用工具数一下文件夹"，它回英文 + 不执行 + 5.7 秒返回。
  //    ⚠️ 哨兵注释里"preset 不是 create 的参数"是错的（源码里它是 createAgent
  //    的请求字段），但就算按源码传也没用——所以别在preset上继续纠缠，直接复用。
  // ══════════════════════════════════════════════════════════════════════

  // <你的工作区>工作区（id 来自 DSH 工作区注册表 ~/.dsh/storages/workspace.json）。
  // boss 2026-10-20 定：从手机/机器人进来的会话一律落<你的工作区>，不串到<你的工作区>/生活。
  const BOT_TASK_CWD = String(config.taskCwd || '').trim() || '<你的数据目录二>/<你的工作区>'
  // <你的工作区>工作区的 id。**建会话时必须传这个**（不是只传 cwd），
  // 否则会话建出来了但没挂到工作区下 → 侧边栏<你的工作区>分组里看不到（10-20 22:40 boss反馈）。
  // 留空 = 运行时按 title「<你的工作区>」从注册表里找，找不到就用下面这个固定的。
  const BOT_WORKSPACE_ID = String(config.workspaceId || '').trim() || '35db73aa-b637-4d9b-9ed8-7d77c0a0285b'

  // ══════════════════════════════════════════════════════════════════════
  // 机器人绑定的硬约束（boss 2026-10-20 定·永久）
  //
  // 原话：「对于以后第一次使用该插件的用户，如果绑定了机器人，
  //        要求必须强制选择工作区作为默认会话的渠道。
  //        如果不选择，不能开启该功能。」
  //
  // 落法（三层，缺一不可）：
  //   ① 机器人凭据存在 ＝ 绑定了机器人 → 必须已经选过工作区，
  //      没选就**拒绝一切会话请求**（后端硬闸，不是靠界面拦）。
  //   ② 界面上「启用机器人」是个开关，绑定时**必须先在下拉里选工作区**，
  //      没选时开关**点不动**、并说明为什么。
  //   ③ 选了工作区之后，机器人开的会话**落那个工作区**，不串。
  //
  // 状态存在哪：本目录下的 bot-setup.json（不落插件配置——
  // 插件配置是部署时写死的，用户在界面上选的东西得能自己改能自己存）。
  // ══════════════════════════════════════════════════════════════════════
  const SETUP_FILE = String(config.setupFile || '').trim()
    || join(dirname(linkFile), 'bot-setup.json')
  /** 机器人的设置：{ bound: bool, workspaceId: string, workspaceTitle: string } */
  function readBotSetup() {
    try {
      const s = JSON.parse(readFileSync(SETUP_FILE, 'utf8'))
      return {
        bound: Boolean(s?.bound),
        workspaceId: String(s?.workspaceId ?? ''),
        workspaceTitle: String(s?.workspaceTitle ?? ''),
      }
    } catch {
      return { bound: false, workspaceId: '', workspaceTitle: '' }
    }
  }
  function writeBotSetup(patch) {
    const cur = readBotSetup()
    const next = { ...cur, ...patch }
    try {
      writeFileSync(SETUP_FILE, JSON.stringify(next, null, 2) + '\n', 'utf8')
    } catch (e) {
      // ⚠️ 这里以前是**静默吞掉**的：writeFileSync 当时压根没 import，
      //    写文件永远失败、异常被 catch 吃掉 → 「保存工作区」看着点了没反应，
      //    「12 小时复用」也因为记不住会话而永远不生效（每次都开新窗口）。
      //    写不出去必须让人看见，别再吞。
      ctx.logger?.error?.('phone-remote: 写机器人设置失败（' + SETUP_FILE + '）: ' + String(e?.message ?? e))
      throw e
    }
    return next
  }
  // 机器人把话投给哪个会话（boss 2026-10-20 选 B：复用已开着的会话，不新建）。
  // 留空 = 自动挑「目标工作区里最近还在动的那个会话」；填了就用指定的。
  const botTargetSession = String(config.botTargetSession || '').trim()
  // 接口口令：机器人跟插件之间的一把共享钥匙。
  // 不给的话，同一网段内任何能连到这个端口的人都能让电脑开会话干活。
  const botToken = String(config.botToken || '').trim()
  // 一次会话最多等多久（手机在外面等太久会以为挂了）
  const BOT_RUN_TIMEOUT_MS = Number(config.botRunTimeoutMs ?? 10 * 60 * 1000)

  // 机器人会话通道的存活期（boss 2026-10-20 定·永久）：12 小时。
  // 12 小时内手机发的话都往同一个会话投；超过 12 小时才开新的。
  const BOT_SESSION_TTL_MS = Number(config.botSessionTtlMs ?? 12 * 60 * 60 * 1000)

  // 「当前机器人会话」的记法：{ sessionId, at }，at = 最后一次用它的时间。
  // 跟 bot-setup.json 放一起（同一件事的两面：选了哪个工作区 + 现在用哪个会话）。
  const BOT_SESSION_FILE = String(config.sessionFile || '').trim()
    || join(dirname(linkFile), 'bot-session.json')
  function readBotSession() {
    try {
      const s = JSON.parse(readFileSync(BOT_SESSION_FILE, 'utf8'))
      return { sessionId: String(s?.sessionId ?? ''), at: Number(s?.at ?? 0) }
    } catch {
      return { sessionId: '', at: 0 }
    }
  }
  function writeBotSession(sessionId, at) {
    try {
      writeFileSync(BOT_SESSION_FILE, JSON.stringify({ sessionId, at: at ?? Date.now() }, null, 2) + '\n', 'utf8')
    } catch (e) {
      // 同样不静默：写不出去 = 12 小时复用永远不生效（每次都开新窗口），
      // 而症状看起来「只是多了几个窗口」，很难往这儿想。
      ctx.logger?.error?.('phone-remote: 写当前会话记录失败（' + BOT_SESSION_FILE + '）: ' + String(e?.message ?? e))
    }
  }
  /** 记一下「刚用了这个会话」，把 12 小时的计时重新起算。 */
  function touchBotSession(sessionId) {
    writeBotSession(sessionId, Date.now())
  }

  /**
   * 机器人这次要用哪个工作区。
   *
   * 硬约束（boss 2026-10-20 定）：**绑了机器人就必须选过工作区，没选不给用。**
   * 所以这里返回 null 就是「闸门关着」，调用方必须拒绝干活。
   *
   * 优先级：用户在界面上选的 > 部署配置里的 > 空（=没选，闸门关）。
   */
  function targetWorkspaceId() {
    const setup = readBotSetup()
    if (setup.workspaceId) return setup.workspaceId
    // 部署时就配了、且用户没在界面上改过 → 视同已选
    // （老用户升级用的路径；新用户绑定时会强制走界面选一次）
    if (setup.bound) return BOT_WORKSPACE_ID
    return ''
  }

  /** 目标工作区的登记对象（挂会话、读路径都要它）。 */
  function targetWorkspace() {
    const id = targetWorkspaceId()
    if (!id) return null
    const registry = ctx.get?.('workspaceRegistry') || ctx.workspaceRegistry
    return registry?.get?.(id) || null
  }

  // 投话时加的前置指令：让模型用纯文字回，别生成卡片。
  // 10-20 22:20 实测踩的坑：DSH 的 genui 插件往系统提示里塞了「你会生成 schemaJson
  // 卡片」那条规则，模型照做，企微那边渲染不了卡片 → boss看到一坨 JSON 噪音。
  // genui 是全局开关（关了会影响 DSH 界面里的卡片），不能动，所以在提问时就说清。
  const BOT_TEXT_ONLY_PREFIX = '【只回纯文字，不要生成卡片、不要输出 schemaJson 或任何代码块】\n'

  /**
   * 把 AI 的回复净化成「能在企微里看的文字」。
   *
   * 就算前置指令没生效（模型顽固地又生成了卡片），这里也能把 schemaJson
   * 代码块剥掉、留下人话，不让一坨 JSON 噪音打到boss脸上。
   */
  function sanitizeReply(raw) {
    let text = String(raw ?? '')
    if (!text) return ''
    // 只剥**卡片**格式（schemaJson），普通代码块保留 —— 那是 AI 正常回答的一部分，
    // 剥了内容就丢了。10-20 22:35 单测发现过这个坑。
    text = text.replace(/```schemaJson\s*\r?\n?[\s\S]*?```/gi, '')
    text = text.replace(/<schemaJson>\s*\r?\n?[\s\S]*?<\/schemaJson>/gi, '')
    text = text.replace(/```schemaJson[\s\S]*$/i, '')
    text = text.trim()
    // 全剥完就只剩噪音了 —— 给句人话，别让boss对着空气
    if (!text) return '（这轮只生成了卡片格式，企微里显示不出来。你可以在电脑上打开那次会话看。）'
    return text
  }

  /**
   * 启动自检：能不能写文件、当前设置是什么。
   *
   * ⚠️ 为什么加这个（10-20 23:15 实测）：
   *   writeFileSync 那会儿压根没 import，写文件永远失败、异常被 catch 吞掉，
   *   症状只是「多了几个窗口」「保存了没反应」——**根本往这儿想**。
   *   所以插件加载时就自己写一次，写不出去**立刻大声报**，别等用到时才暴露。
   */
  ctx.effect(() => {
    const problems = []
    try {
      writeFileSync(SETUP_FILE + '.selftest', String(Date.now()), 'utf8')
      try { unlinkSync(SETUP_FILE + '.selftest') } catch { /* 删不掉就留着，不影响 */ }
    } catch (e) {
      problems.push('设置文件写不出去（' + SETUP_FILE + '）：' + String(e?.message ?? e))
    }
    const setup = readBotSetup()
    ctx.logger?.info?.(
      `phone-remote: 自检 ${problems.length ? '❌ ' + problems.join('；') : '✅ 通过'}` +
      `｜绑定=${setup.bound ? '是' : '否'} 工作区=${setup.workspaceTitle || '（未选）'}` +
      `｜会话记录=${readBotSession().sessionId || '（无）'}`,
    )
  })

  /**
   * 取某一轮的**完整** AI 回复。
   *
   * ⚠️⚠️ 10-20 23:27 boss反馈「回复被截断」查出来的坑：
   *   ``turnOutline`` 投影里的 ``response`` **只存 120 字符的摘要**——
   *   boss实测要 500 字，回来正好 120 字、末尾带「…」。
   *   **截断的真凶是它，不是企微**（企微单条上限 20480 字节 ≈ 6800 汉字）。
   *   所以不能拿 turnOutline 当回复来源。
   *
   * 正确来源：``ctx.sessionController.page({address, throughSeq, maxMessages}, signal)``
   *   ——它给**完整事件**（源码 dsh-api-session-controller/lib/index.js:1475）。
   *   ⚠️ 两个参数坑：
   *     ① throughSeq 是「取到第几条为止」的上界，**-1 表示什么都不要**（实测 0 条）；
   *        要取到最新就传一个足够大的数。
   *     ② 第二个参数是 **AbortSignal**（漏了报 "cannot read properties of undefined
   *        (reading 'throwIfAborted')"）——跟 prompt/page 一路的通病。
   */
  /**
   * 取某会话的完整事件（page 接口）。
   *
   * ⚠️ throughSeq 的坑（10-20 23:45 实测，两个都踩了）：
   *   ① -1 = 什么都不要（返回 0 条）
   *   ② 传太大 = "past cursor N"（超出上限报错）
   *   正确做法：**先问出最后一条的 seq（cursor），再按它取**。
   *   cursor 从 turnBoundary 投影里拿；拿不到就用「故意传大值 → 从报错里抠 cursor」兜底。
   */
  async function pageSession(sessionId, maxMessages = 200) {
    const signal = new AbortController().signal
    let cursor = -1
    try {
      const a0 = ctx.agents.get(sessionId)
      const o0 = ctx.sessionProjections?.stateOf(a0?.session, 'turnBoundary')
      const last = o0?.val?.lastStepBoundary?.seq
      if (Number.isInteger(last) && last >= 0) cursor = last
    } catch { /* 取不到就试别的 */ }
    if (cursor < 0) {
      try {
        await ctx.sessionController.page({
          address: { kind: 'session', sessionId },
          throughSeq: Number.MAX_SAFE_INTEGER,
          maxMessages: 1,
        }, signal)
      } catch (e) {
        const m = String(e?.message ?? e).match(/past cursor (\d+)/)
        if (m) cursor = Number(m[1])
      }
    }
    return await ctx.sessionController.page({
      address: { kind: 'session', sessionId },
      throughSeq: cursor >= 0 ? cursor : Number.MAX_SAFE_INTEGER,
      maxMessages,
    }, signal)
  }

  /**
   * 取某会话的**最后一轮**完整回复。
   *
   * @param sessionId  会话 id
   * @param afterTurn  只要 turn > 这个数的回复（投话前该会话已到的最大 turn 号）。
   *                   不传 = 不限（取最后一条）。
   *
   * ⚠️⚠️ 真实结构（10-21 00:22 探针实测，**原样打出来的**）：
   *   **一轮（turn）里有多个 step**，每个 step 一条 assistant 消息：
   *     turn=3 step=1 → "User asks about tomorrow's Shanghai weat…"  ← 英文复述（思考）
   *     turn=3 step=2 → "Web search unavailable…"                  ← 工具提示（思考）
   *     turn=3 step=3 → 空（没写完）
   *     turn=3 step=4 → **"明天（10月21日）上海：凌晨到清晨有小雨…"** ← **真答案**
   *   所以：**真答案是「这一轮里最后一个有 blockEnd 的 step」**。
   *   只取最后一条会拿到英文复述；取 step=1 更会拿到思考过程。
   *
   *   turn 号在 page（data.turn）和 turnOutline（turns[].turn）里**是同一个编号**
   *   ——两边对得上，所以能用 turn 精确限定"这一轮"，不用猜编号规律。
   */
  /**
   * 读备用模型链（<你的工作区>的全局配置）。
   * 文件：<你的工作区>\全局配置.json 的 fallbacks 数组。
   * ⚠️ 10-21 09:10 读源码确认过链的结构（5 条）：
   *   our-free-model/opencode/deepseek-v4.1-flash-free（Our Free Model / EAC DeepSeek V4.1 Flash Free）
   *   our-free-model/minimax/minimax-m3.1-flash:free（Our Free Model / Kilo MiniMax M3.1 Flash）
   *   qoder/qfmodel（Qoder / Qwen3.8-Flash 免费）
   *   raccoon/sn-sensenova-6-8-flash（Raccoon / SenseNova-6.8-Flash 免费）
   *   minimax1/MiniMax-M3.1-Flash（OpenAI Compatible / M3.1-Flash）
   */
  function readFallbackChain() {
    const candidates = [
      '<你的数据目录二>/<你的工作区>/<你的工作区>/全局配置.json',
      'E:\\deepseek\\<你的工作区>\\<你的工作区>\\全局配置.json',
    ]
    for (const p of candidates) {
      try {
        if (!existsSync(p)) continue
        const raw = JSON.parse(readFileSync(p, 'utf8'))
        const arr = Array.isArray(raw?.fallbacks) ? raw.fallbacks : []
        const out = []
        for (const f of arr) {
          const provider = String(f?.provider ?? '').trim()
          const model = String(f?.model ?? '').trim()
          if (!provider || !model) continue
          out.push({
            id: String(f?.id ?? provider + '::' + model),
            provider, model,
            label: String(f?.label ?? f?.name ?? (provider + ' / ' + model)),
          })
        }
        if (out.length) return out
      } catch { /* 读不到就试下一个 */ }
    }
    return []
  }

  /**
   * 列出 DSH 里**实际可用**的模型 + 链里哪些能用（探针接口用）。
   * ⚠️ 10-21 09:15 探针先行的要求：换模型前必须先知道
   *    「这个 provider/model 在 DSH 里到底存不存在」——
   *    不然切过去直接报 session/model-unavailable，白折腾一轮。
   */
  async function listAvailableModels() {
    const out = { providers: [], chain: [] }
    try {
      // 取 llm 服务：两种写法都试（<你的工作区>插件用的是 ctx.get('llm')）
      const llm = (typeof ctx.get === 'function' ? ctx.get('llm') : null) || ctx.llm || null
      out.llmAvailable = Boolean(llm)
      const providers = llm?.listProviders?.() || []
      for (const p of providers) {
        const id = String(p?.id ?? '')
        let models = []
        try {
          const ms = await llm.listModels(id)
          models = (ms || []).map((m) => String(m?.id ?? '')).filter(Boolean)
        } catch (e) {
          models = ['（读取失败: ' + String(e?.message ?? e) + '）']
        }
        out.providers.push({ id, name: String(p?.name ?? id), models })
      }
    } catch (e) {
      out.error = String(e?.message ?? e)
    }
    const chain = readFallbackChain()
    for (const f of chain) {
      const prov = out.providers.find((p) => p.id === f.provider)
      const models = prov?.models || []
      out.chain.push({
        ...f,
        providerExists: Boolean(prov),
        modelExists: models.includes(f.model),
        available: Boolean(prov) && models.includes(f.model),
      })
    }
    return out
  }

  async function fetchFullReply(sessionId, afterTurn = 0) {
    // ⓪ **取锚点（turnOutline 的正式答案）—— 每次调用都要重新取**。
    //    ⚠️⚠️ 10-21 07:10 实测踩到（boss又收到英文）：
    //      原来锚点**只在函数开头取一次**。而调用时机是"刚投完话、模型还在跑"，
    //      那一刻 turnOutline 里**还没有这一轮的 response** → 锚点空 →
    //      走到"没有锚点"分支 → 取了 page 里的英文思考 → boss收到英文。
    //    现在：锚点在**轮询循环里每轮重取**，取到才算。
    const readAnchor = () => {
      let turn = 0
      let text = ''
      try {
        const a0 = ctx.agents.get(sessionId)
        const o0 = ctx.sessionProjections?.stateOf(a0?.session, 'turnOutline')
        const turns0 = (o0 && Array.isArray(o0.turns)) ? o0.turns : []
        for (let i = turns0.length - 1; i >= 0; i--) {
          const t = turns0[i]
          const resp = String(t?.response || '').trim()
          const tn = Number(t?.turn ?? 0)
          if (resp && tn > afterTurn) { turn = tn; text = resp; break }
        }
      } catch { /* 取不到就当没有锚点 */ }
      return { turn, text }
    }
    let anchor = readAnchor()
    let anchorTurn = anchor.turn
    let anchorText = anchor.text

    // ① 用 page 拿完整事件
    try {
      const page = await pageSession(sessionId, 200)
      const recs = page?.records || []
      // page 的每条是 { type:'event', event:{ type, data } }（源码 entryFor）。
      //
      // ⚠️ assistant 的正文**不在 data.content 里**（content 是空的），
      //    在 **data.stream** 里（源码 dsh-session/lib/types/index.js:214 校验
      //    `Array.isArray(data.stream)`；assistant/message 自带 source stream）。
      //
      // ⚠️⚠️ stream 的真实结构（10-20 23:55 探针实测，原样打出来的，**不是我猜的**）：
      //   ① { type:'text-chunks', time0, index, dt, texts:["正文片段", ...] }   ← 增量
      //   ② { type:'chunk', time, chunk:{ type:'block-end', index,
      //         block:{ type:'text', text:'完整正文' } } }                     ← 写完的正文
      //   ③ { type:'chunk', time, chunk:{ type:'block-start', index, blockType:'text' } }
      //   ④ { type:'chunk', time, chunk:{ type:'usage', usage:{...} } }
      //   ⑤ { type:'chunk', time, chunk:{ type:'finish', reason:{ kind:'stop' } } }
      //
      // ⚠️⚠️ **只认 ②，绝不用 ①**（10-20 23:59 实测踩到）：
      //   ① 是**流式增量**——模型正在写的时候它就有内容了。
      //   我之前"没有 block-end 就退回增量"，结果把模型的**内心独白**
      //   （"Let me write ~500 字."）当成最终回复发出去，还 0.3 秒就返回（没等它写完）。
      //   **判据必须是「这段正文写完了」** = 出现 block-end。
      //
      // ⚠️⚠️⚠️ **一条消息里可能有多个 block，要全部拼起来**（10-21 08:45 实测踩到）：
      //   实测 turn=5（问西湖十景）：
      //     block 0 = 3780 字，**英文思考**（"The user wants ~600 words about ten famo…"）
      //     block 1 = 700 字，**中文正式答案**（"杭州西湖的"十景"，定名于南宋乾道年间…"）
      //   我原来只返回**第一个** block-end → 拿到英文 → 跟摘要匹配不上 →
      //   退回 120 字摘要 → boss收到一串没展开的中文。
      //   现在：**按顺序拼接所有 block-end 的文本**，再交给下面的锚点定位。
      const extractFromStream = (stream) => {
        const blocks = []
        for (const p of stream) {
          const b = p?.chunk?.block
          if (b && typeof b.text === 'string' && b.text.trim()) blocks.push(b.text)
        }
        if (blocks.length) return blocks.join('\n')
        // ② 没写完 → 返回空（**不拿增量当回复**，宁可多等一轮）
        return ''
      }

      // 收集投话之后新产生的所有 assistant 消息。
      const candidates = []
      for (let i = 0; i < recs.length; i++) {
        const ev = recs[i]?.event ?? recs[i]
        const etype = String(ev?.type ?? recs[i]?.type ?? '')
        if (!/assistant/i.test(etype)) continue
        const data = ev?.data ?? ev
        const turn = Number(data?.turn ?? 0)
        const step = Number(data?.step ?? 0)
        if (turn <= afterTurn) continue
        const stream = Array.isArray(data?.stream) ? data.stream : []
        let text = extractFromStream(stream)
        // 兜底：万一这版把正文放在 content 里
        if (!text.trim()) {
          const c = data?.content
          if (typeof c === 'string') text = c
          else if (Array.isArray(c)) {
            text = c.map((p) => (typeof p === 'string' ? p : String(p?.text ?? ''))).join('')
          } else if (c && typeof c === 'object') text = String(c.text ?? '')
        }
        candidates.push({ turn, step, text: text.trim() })
      }
      // 按轮分组，每轮取最后一个有正文的 step（真实形态见下面注释）
      const byTurn = new Map()
      for (const c of candidates) {
        if (!c.text) continue
        const cur = byTurn.get(c.turn)
        if (!cur || c.step > cur.step) byTurn.set(c.turn, c)
      }
      const perTurn = Array.from(byTurn.values()).sort((a, b) => a.turn - b.turn)

      // ⚠️⚠️ **用锚点定位**（10-21 00:30 / 00:45 两次实测得出的关键事实）：
      //   同一轮里，page 取到的最后一条**可能是英文复述**（模型刚开始思考那一步），
      //   而 turnOutline 的 response **一定是正式答案**。
      //   实测对照（boss 00:34 问「明天下雨 穿衣建议」那轮 turn=2）：
      //     step=1 → "Simple question, answer in plain text."            ← 英文思考
      //     step=2 → "Web search failed. Let me try web_fetch"          ← 英文
      //     step=3 → "Try another source, e.g. wttr.in."                ← 英文
      //     step=4 → "Note: current date per runtime context…"（2308字） ← **真答案**
      //   turnOutline.response = 「明天（10-22）杭州一带白天最高 22℃…」   ← 对
      //
      //   ⚠️⚠️ 两个曾经的错法（都导致boss收到英文）：
      //     ① 只取「每轮最后一个有正文的 step」→ 挤掉了 step=4，拿到 step=1 的英文；
      //     ② 用「开头 24 字一致」匹配 → 中文摘要和英文正文开头天然对不上，必然失败。
      //   现在：**这一轮的所有 step 一起找**，用「**包含锚点里的中文片段**」匹配。
      if (anchorText) {
        // ⚠️⚠️ 10-21 00:52 最终判据（用boss那两轮的真实数据定的）：
        //   page 的长文 = **英文思考 + 中文正式答案拼在一起**：
        //     turn=2 step=4：开头 "Note: current date per runtime context…"（英文思考）
        //                  后面才是「明天（10-22）杭州一带白天最高 22℃…」（中文答案）
        //     turn=4 step=1：整条都是英文思考，而中文答案**只存在于摘要层**
        //   所以：
        //     ① **在长文里找摘要开头那个片段的位置** → 从那儿**截到结尾** = 纯中文答案。
        //     ② 找不到（这一轮的中文答案压根没进 page）→ **直接用摘要**（120 字，一定对）。
        //   **绝不再用「取最长那条」**——那正是把英文思考发出去的原因。
        const head = anchorText.slice(0, 20)
        const inTurn = candidates.filter((c) => c.turn === anchorTurn && c.text)
        for (let k = inTurn.length - 1; k >= 0; k--) {
          const t = inTurn[k].text
          const at = t.indexOf(head)
          if (at < 0) continue
          // 从中文答案起点截到结尾（去掉前面的英文思考）
          let cn = t.slice(at)
          // 切掉英文收尾：从末尾往前找最后一个中文句号
          const lastStop = cn.lastIndexOf('。')
          if (lastStop >= 0) cn = cn.slice(0, lastStop + 1)
          // 再去掉尾部的零散标点
          cn = cn.replace(/[，、；：！？,;:!?]+\s*$/u, '').trim()
          if (cn) return cn
        }
        // 这一轮的中文答案不在 page 里 → **用摘要**（内容一定对，代价是最多 120 字）
        return anchorText
      }

      // ⚠️⚠️ **没有锚点时必须返回空，绝不能返回 page 里的内容**（10-21 07:10 实测踩到）：
      //   锚点取不到 = 这一轮**还没写完**（turnOutline 里还没有它的 response）。
      //   原来这里"取最后一个有正文的轮次"→ 那是 **page 里的英文思考** →
      //   boss收到英文（实测 688 字节 "The user wants a file written at…"）。
      //   现在返回空 → 外层轮询**继续等**，等锚点出现再取。
      return ''
    } catch (e) {
      ctx.logger?.warn?.('phone-remote: page 取完整回复失败: ' + String(e?.message ?? e))
    }
    // turnOutline 读不到、page 也没取到 → 退回锚点（120 字摘要，但内容对）
    if (anchorText) return anchorText
    return ''
  }

  /**
   * 找出这一轮**产出/改动过的文件**（boss 2026-10-21 01:00 定的 A1 方案：
   * 「这轮新写/改过/明确交付的文件都发过去」）。
   *
   * 数据来源：会话事件里两类
   *   · tool/call(name=write / edit / present) —— ⚠️ arguments 是 **JSON 字符串**（实测）
   *   · deliverables/presented —— data.files[].path
   * 跟<你的工作区>插件是同一套判据（那边用它建索引）。
   *
   * ⚠️⚠️ **不能只按 turn 过滤**（10-21 01:30 实测踩到）：
   *   `deliverables/presented` 事件**不带 turn 字段**（它是会话级交付事件），
   *   所以 turn 过滤对它完全无效 → 结果把**之前几轮**的文件也捞进来了
   *   （实测捞到了 _媒体测试、_媒体测试2 这些旧文件）。
   *   **正确判据＝文件修改时间**：投话之后（sinceMs）被改动过的文件才算这轮的。
   *   turn 号只用来排除 tool/call 里明显更早的。
   *
   * @param sessionId 会话 id
   * @param sinceMs   投话时刻（毫秒）；只收这之后被改动的文件
   * @param afterTurn 只要 turn > 这个数的 tool/call（辅助过滤）
   * @returns [{ path, name, kind, desc, bytes, exists, mtimeMs }]
   */
  async function collectProducedFiles(sessionId, sinceMs = 0, afterTurn = 0) {
    const out = []
    const seen = new Set()
    try {
      const page = await pageSession(sessionId, 400)
      const recs = page?.records || []
      for (const rec of recs) {
        const ev = rec?.event ?? rec
        const etype = String(ev?.type ?? rec?.type ?? '')
        const data = ev?.data ?? ev
        const turn = Number(data?.turn ?? 0)
        let p = ''
        let kind = ''
        let desc = ''
        if (etype === 'tool/call') {
          const name = String(data?.name ?? data?.tool ?? '')
          if (!['write', 'edit', 'present'].includes(name)) continue
          let a = data?.arguments ?? data?.args ?? data?.input ?? {}
          if (typeof a === 'string') { try { a = JSON.parse(a) } catch { a = {} } }
          p = String(a?.path ?? a?.file_path ?? a?.filePath ?? '')
          kind = 'tool/' + name
          desc = String(a?.description ?? a?.message ?? '')
        } else if (etype === 'deliverables/presented') {
          const list = (data?.files || data?.presented) || []
          for (const f of list) {
            const fp = String(f?.path ?? '')
            if (!fp) continue
            const key = fp.toLowerCase()
            if (seen.has(key)) continue
            seen.add(key)
            let st = null
            try { st = statSync(fp) } catch { /* 读不到 */ }
            // ⚠️ **文件已经不存在 → 直接不要**（10-21 09:30 实测踩到）：
            //   产出物事件是**累积**的，会话里早期轮次交付过的文件一直在列表里。
            //   那些文件后来被删了（我清测试文件时删的），但事件还在 →
            //   收集时把"不存在的"也发出去 → 机器人那边读不到、只能发一句说明。
            //   现在插件侧就滤掉（**不存在 = 没产出物**）。
            if (!st) continue
            // ⚠️ 时间闸：这轮之前改过的文件不算这轮的产出
            if (sinceMs && st.mtimeMs < sinceMs) continue
            out.push({
              path: fp, name: basename(fp), kind: 'presented',
              desc: String(f?.description ?? ''),
              bytes: st.size, exists: true,
              mtimeMs: st.mtimeMs,
            })
          }
          continue
        } else {
          continue
        }
        if (!p) continue
        // tool/call 带 turn → 排除更早的（辅助）
        if (turn && turn <= afterTurn) continue
        const key = p.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        let bytes = -1
        let exists = false
        let mtimeMs = 0
        try {
          const st = statSync(p)
          exists = true
          bytes = st.size
          mtimeMs = st.mtimeMs
        } catch { /* 读不到就当不存在 */ }
        // ⚠️ 文件不存在 → 不要（跟 presented 一个道理：10-21 09:30 实测踩到）
        if (!exists) continue
        // ⚠️ 时间闸：投话之前改过的文件不算这轮的产出
        if (sinceMs && mtimeMs < sinceMs) continue
        out.push({ path: p, name: basename(p), kind, desc, bytes, exists, mtimeMs })
      }
    } catch (e) {
      ctx.logger?.warn?.('phone-remote: 收集产出文件失败: ' + String(e?.message ?? e))
    }
    return out
  }

  /**
   * 挑一个接话的会话。
   *
   * ⚠️ 2026-10-20 实测踩过的坑（都靠探针/报错钉死，不是猜的）：
   *
   * ① **不能往 UI 正在管的会话投消息**。
   *    往一个界面上开着的会话外部投消息，消息会进队列但**没人取**：
   *    turnOutline 的轮次一直涨（55→56→57→58），但真会话的 sessionStats.turns
   *    纹丝不动、token 零增长、prompt 和 response 全是空、phase 恒为 idle。
   *    等 240 秒超时也没得到回复。**往别人正操作着的抽屉里塞纸条，就是这效果。**
   *
   * ② **自己 ctx.agents.create() 建的会话没有工具**（preset=null、工具 253 token，
   *    正常会话 12373），AI 自述"没有命令/文件读写工具"。试过四种挂法全无效：
   *    setup 里 await agentPresets.select()（会卡死，模型一次不跑）、
   *    fire-and-forget、session.append 事件、create 传 agentPreset。
   *
   * ③ 正确的建会话入口是 **ctx.sessionController.create()**：
   *    它接受 {workspaceId, agentPreset}，内部走 agents.createSession，
   *    preset 由它自己处理——这跟 ctx.agents.create() 不是同一套。
   *    源码 dsh-api-session-controller/lib/index.js:755。
   *
   * ── 12 小时复用（boss 2026-10-20 定·永久）──────────────────────────
   * 「用手机发起会话，默认一个会话通道保留 12 个小时。
   *   否则，每次发一条消息都重新开启一条会话通道，新窗口就太多了。
   *   如果超过 12 个小时，则开启新的会话窗口。」
   *
   * 做法：记住「当前机器人会话 id + 最后一次用它的时间」。
   *   12 小时内继续用同一个；超过 12 小时（或那个会话已经不在了）才新建。
   *   每用一次就刷新计时（boss继续用就一直是同一条通道）。
   */
  async function pickTargetSession() {
    // boss指定了就用指定的
    if (botTargetSession) {
      const got = ctx.agents.get(botTargetSession)
      if (got) return botTargetSession
      ctx.logger?.warn?.(`phone-remote: 指定的 botTargetSession=${botTargetSession} 不是活着的会话，改为自动建新会话`)
    }

    // ① 12 小时内的旧会话还在 → 继续用
    const cur = readBotSession()
    if (cur?.sessionId) {
      const ageMs = Date.now() - Number(cur.at || 0)
      const alive = ctx.agents.get(cur.sessionId)
      if (alive && ageMs < BOT_SESSION_TTL_MS) {
        ctx.logger?.info?.(`phone-remote: 复用 12 小时内的会话 ${cur.sessionId}（上次用是 ${Math.round(ageMs / 60000)} 分钟前）`)
        touchBotSession(cur.sessionId)
        return cur.sessionId
      }
      if (!alive) {
        ctx.logger?.info?.(`phone-remote: 记住的会话 ${cur.sessionId} 已经不在了，重新开一个`)
      } else {
        ctx.logger?.info?.(`phone-remote: 会话 ${cur.sessionId} 已超过 12 小时，重新开一个`)
      }
    }
    return null
  }

  /**
   * 建一个**属于机器人自己的**会话（不碰 UI 正在管的那些）。
   *
   * 走 sessionController.create({workspaceId, agentPreset}) —— 官方的建会话入口，
   * preset 由它内部处理（这正是 ctx.agents.create() 缺的那一环）。
   * 源码 dsh-api-session-controller/lib/index.js:755。
   *
   * ⚠️ **必须传 workspaceId，不能只传 cwd**（10-20 22:40 boss反馈「侧边栏<你的工作区>下面
   *    看不到机器人开的会话」查出来的）：
   *   源码 759/776 行——传了 workspaceId 才会走 `workspace.attachSession(sessionId)`
   *   把会话挂到工作区下；只传 cwd 的话**只建会话、不挂工作区**，
   *   会话就掉进「未分组」，侧边栏<你的工作区>分组下面根本看不到。
   *   （跟<你的工作区>今早踩的同一个坑，一个字：attachSession 不会被自动调。）
   *   另注意：757 行说「workspaceId 和 cwd 不能同时传」，所以这里只传 workspaceId。
   */
  async function createBotSession() {
    const wsId = targetWorkspaceId()
    if (!wsId) throw new Error('还没选工作区，机器人不能开会话')
    const created = await ctx.sessionController.create({
      workspaceId: wsId,
      agentPreset: 'standard',
    })
    const id = String(created?.sessionId ?? '')
    if (!id) throw new Error('建会话没给出 sessionId')
    // 记下来：12 小时内手机再发话就复用这个，不再开新窗口
    writeBotSession(id, Date.now())
    ctx.logger?.info?.(`phone-remote: 建了新会话 id=${id} 工作区=${wsId} preset=${created?.agentPreset ?? 'standard'}`)
    return id
  }

  /** 取 DSH 的默认模型参数；取不到就让 DSH 自己兜底。 */
  function defaultAgentOptions() {
    try {
      const adm = typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : (ctx.agentDefaultModel || null)
      const sel = adm?.currentSelection?.()
      if (sel && sel.model) {
        return {
          provider: sel.provider,
          model: sel.model,
          ...(sel.reasoningEffort ? { reasoningEffort: sel.reasoningEffort } : {}),
        }
      }
    } catch { /* 取不到就让 DSH 自己兜底 */ }
    return {}
  }

  /** 简易 JSON 响应（不引外部依赖）。 */
  function sendJson(res, body, status = 200) {
    const text = JSON.stringify(body)
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(text)
  }

  /**
   * 读请求体（POST 的 JSON）。
   *
   * ⚠️⚠️ 10-20 22:53 实测踩的坑（这个坑很隐蔽，值得记）：
   *   **请求体读不到，流被 gzip 中间件吃掉了。**
   *   根因在 DSH 源码 dsh-host-webserver/lib/index.js:214——
   *     `const gzipRequest = Object.create(req);` 然后
   *     `middleware(gzipRequest, res, next)`。
   *   gzip 中间件拿的是**用 req 做原型造的替身**；替身和真 req 共享同一份底层流
   *   （事件监听器不共享），于是**替身把流读完了，真 req 再读就是空的**。
   *   表现：POST 带 body，handler 里 body 恒为 {} ⇒
   *   「不选工作区就绑定」这种请求全被当默认值放行，**硬闸形同虚设**。
   *
   * 所以现在**优先走 header/query 传参**（不经过流，一定能拿到），
   * 流式读取只当兜底。
   */
  function readBody(req) {
    // ① header（最稳：不经过流）
    const hdr = req?.headers || {}
    for (const key of ['x-bot-payload', 'x-body']) {
      const v = hdr[key]
      if (typeof v === 'string' && v.trim()) {
        // 机器人侧是 URL 编码过的，先解
        let raw = v
        try { raw = decodeURIComponent(v) } catch { /* 不是编码的就原样用 */ }
        try { return Promise.resolve(JSON.parse(raw)) } catch { /* 继续下一条 */ }
      }
    }
    // ② query
    try {
      const q = new URL(req?.url || '', 'http://x').searchParams
      const v = q.get('payload') || q.get('body')
      if (v) return Promise.resolve(JSON.parse(v))
    } catch { /* 继续下一条 */ }

    // ③ host 挂在 req 上的
    for (const key of ['body', 'rawBody', 'parsedBody']) {
      const v = req?.[key]
      if (v && typeof v === 'object') return Promise.resolve(v)
      if (typeof v === 'string' && v.trim()) {
        try { return Promise.resolve(JSON.parse(v)) } catch { /* 继续下一条 */ }
      }
    }

    // ④ 流式兜底（大概率已经被 gzip 替身吃掉了）
    return new Promise((resolve, reject) => {
      let raw = ''
      let done = false
      const finish = (fn, arg) => { if (done) return; done = true; fn(arg) }
      try {
        req.on('data', (c) => {
          raw += c
          if (raw.length > 256 * 1024) { finish(reject, new Error('请求体太大')); req.destroy() }
        })
        req.on('end', () => {
          if (!raw) { finish(reject, new Error('请求体已被 gzip 中间件读走（改用 header 传参）')); return }
          try { finish(resolve, JSON.parse(raw)) } catch { finish(reject, new Error('请求体不是合法 JSON')) }
        })
        req.on('error', (e) => finish(reject, e))
        if (req.readableEnded || req.complete === true) {
          if (!raw) finish(reject, new Error('请求体已被读走（改用 header 传参）'))
        }
      } catch (e) {
        finish(reject, e)
      }
    })
  }

  function checkToken(req) {
    if (!botToken) return true // 没配口令就不校验（本机/内网自用）
    const got = String(req.headers['x-bot-token'] || '')
    return got === botToken
  }

  ctx.effect(() => {
    const disposers = []

    /**
     * GET  /api/phone-remote/bot-setup  → 现状：绑没绑、选了哪个工作区、有哪些工作区可选
     * POST /api/phone-remote/bot-setup  → 改：{ bound, workspaceId }
     *
     * 用途：前端「启用机器人」那块界面要靠它渲染下拉框、并判断能不能开。
     * 规矩（boss 2026-10-20 定）：**绑了机器人就必须选工作区，没选不给用**。
     * 所以 POST 里 bound=true 且没给 workspaceId → 直接拒绝。
     */
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/api/phone-remote/bot-setup',
      async handler(req, res) {
        const isPost = String(req.method || 'GET').toUpperCase() === 'POST'
        try {
          const registry = ctx.get?.('workspaceRegistry') || ctx.workspaceRegistry
          const list = registry?.list?.() || []
          const workspaces = list.map((w) => ({
            id: String(w?.id ?? ''),
            title: String(w?.title ?? w?.path ?? ''),
            path: String(w?.path ?? ''),
            sessionCount: (w?.sessionIds || []).length,
          }))

          if (!isPost) {
            const s = readBotSetup()
            sendJson(res, {
              ok: true,
              bound: s.bound,
              workspaceId: s.workspaceId,
              workspaceTitle: s.workspaceTitle,
              // 界面上「能不能开」的判据：没绑随便绑；绑了必须已经有工作区
              canEnable: !s.bound || Boolean(s.workspaceId),
              workspaces,
            })
            return
          }

          // POST：改设置
          let body = {}
          let bodyErr = ''
          try {
            body = await readBody(req)
          } catch (e) {
            bodyErr = String(e?.message ?? e)
            body = {}
          }
          ctx.logger?.info?.(`phone-remote: bot-setup POST body=${JSON.stringify(body)} err=${bodyErr} reqKeys=${Object.keys(req || {}).join(',')} hasBodyProp=${typeof req?.body} readableEnded=${req?.readableEnded}`)
          const patch = {}

          if (body.bound !== undefined) patch.bound = Boolean(body.bound)

          if (body.workspaceId !== undefined) {
            const wid = String(body.workspaceId || '').trim()
            if (wid) {
              const hit = workspaces.find((w) => w.id === wid)
              if (!hit) {
                sendJson(res, { ok: false, error: '没有这个工作区：' + wid }, 400)
                return
              }
              patch.workspaceId = wid
              patch.workspaceTitle = hit.title
            } else {
              patch.workspaceId = ''
              patch.workspaceTitle = ''
            }
          }

          // 硬约束：绑定时**必须**有工作区
          const merged = { ...readBotSetup(), ...patch }
          if (merged.bound && !merged.workspaceId) {
            sendJson(res, {
              ok: false,
              error: '启用机器人前必须先选一个默认工作区——机器人开的会话要落在那里。',
            }, 400)
            return
          }

          const saved = writeBotSetup(patch)
          ctx.logger?.info?.(`phone-remote: 机器人设置已更新 bound=${saved.bound} workspace=${saved.workspaceTitle || '（未选）'}`)
          sendJson(res, { ok: true, bound: saved.bound, workspaceId: saved.workspaceId, workspaceTitle: saved.workspaceTitle })
        } catch (e) {
          sendJson(res, { ok: false, error: String(e?.message ?? e) }, 500)
        }
      },
    }))

    /**
     * 探针：试 page 接口能不能拿到完整 assistant 消息。
     * ⚠️ 只在本机用（localhost 直连），跟 bot-session 同一个口令。
     */
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/api/phone-remote/page-probe',
      async handler(req, res) {
        const out = { ok: false }
        try {
          const body = await readBody(req)
          const sid = String(body?.sessionId || '')
          if (!sid) { out.error = '缺 sessionId'; sendJson(res, out); return }
          // throughSeq 的两个坑（-1=什么都不要 / 太大=past cursor）见 pageSession。
          const page = await pageSession(sid, 200)
          const recs = page?.records || []
          out.count = recs.length
          out.hasMore = page?.hasMore
          // 按 page 的真实结构解析：{ type:'event', event:{ type, data } }
          // ⚠️ assistant 正文在 data.stream（不是 data.content）——见 fetchFullReply 注释。
          const parsed = recs.map((rec) => {
            const ev = rec?.event ?? rec
            const data = ev?.data ?? ev
            const stream = Array.isArray(data?.stream) ? data.stream : []
            let text = stream
              .map((p) => (typeof p === 'string' ? p : String(p?.text ?? '')))
              .join('')
            if (!text.trim()) {
              const c = data?.content
              if (typeof c === 'string') text = c
              else if (Array.isArray(c)) {
                text = c.map((p) => (typeof p === 'string' ? p : String(p?.text ?? ''))).join('')
              } else if (c && typeof c === 'object') text = String(c.text ?? '')
            }
            return {
              evType: String(ev?.type ?? ''),
              recType: String(rec?.type ?? ''),
              turn: data?.turn, step: data?.step,
              streamLen: stream.length,
              textLen: text.length,
              textBytes: Buffer.byteLength(text, 'utf8'),
              head: text.slice(0, 120),
              tail: text.slice(-80),
            }
          })
          // 直接把 assistant 的 stream 原样打出来（看它每一项长什么样）
          for (const rec of recs) {
            const ev = rec?.event ?? rec
            const etype = String(ev?.type ?? '')
            if (!/assistant/i.test(etype)) continue
            const data = ev?.data ?? ev
            const stream = Array.isArray(data?.stream) ? data.stream : []
            out.assistantStreams = stream.map((p) => ({
              keys: p && typeof p === 'object' ? Object.keys(p) : typeof p,
              type: p?.type,
              raw: JSON.stringify(p).slice(0, 300),
            }))
            out.assistantDataKeys = data && typeof data === 'object' ? Object.keys(data) : []
            // data.message 是不是标准消息对象（role/content）——如果是，直接用它最省事
            const msg = data?.message
            out.assistantMessage = msg && typeof msg === 'object' ? {
              keys: Object.keys(msg),
              role: msg.role,
              type: msg.type,
              contentType: typeof msg.content,
              contentIsArray: Array.isArray(msg.content),
              contentLen: typeof msg.content === 'string' ? msg.content.length : (JSON.stringify(msg.content || '').length),
              contentHead: JSON.stringify(msg.content).slice(0, 400),
            } : null
            break
          }
          out.parsed = parsed.slice(-10)
          // ⚠️ 探针（10-21 01:00）：这一轮产生了哪些**文件**？
          //   boss 01:00 反馈「不能只给纯文字，图片文档也得发」——
          //   要发媒体，就得先知道这轮产出了什么文件。
          //   事件来源（跟<你的工作区>插件同一套判据）：
          //     tool/call(name=write/edit/present) → arguments 是 **JSON 字符串**
          //     deliverables/presented → data.files[].path
          const produced = []
          for (const rec of recs) {
            const ev = rec?.event ?? rec
            const etype = String(ev?.type ?? rec?.type ?? '')
            const data = ev?.data ?? ev
            if (etype === 'tool/call') {
              const name = String(data?.name ?? data?.tool ?? '')
              if (!['write', 'edit', 'present'].includes(name)) continue
              // ⚠️ arguments 是 JSON **字符串**（实测），不是对象
              let a = data?.arguments ?? data?.args ?? data?.input ?? {}
              if (typeof a === 'string') { try { a = JSON.parse(a) } catch { a = {} } }
              const p = a?.path ?? a?.file_path ?? a?.filePath ?? ''
              produced.push({ kind: 'tool/' + name, path: String(p || ''), desc: String(a?.description ?? a?.message ?? '') })
            } else if (etype === 'deliverables/presented') {
              const list = (data?.files || data?.presented) || []
              for (const f of list) produced.push({ kind: 'presented', path: String(f?.path ?? ''), desc: String(f?.description ?? '') })
            }
          }
          out.produced = produced
          // ⚠️ 定位"新产生的那条"需要知道：assistant 消息一共几条、每条的 turn/step。
          //    这一段就是给boss看真实数据用的（探针），别删。
          const aList = []
          for (let i = 0; i < recs.length; i++) {
            const ev = recs[i]?.event ?? recs[i]
            const etype = String(ev?.type ?? recs[i]?.type ?? '')
            if (!/assistant/i.test(etype)) continue
            const data = ev?.data ?? ev
            const stream = Array.isArray(data?.stream) ? data.stream : []
            let txt = ''
            for (const p of stream) {
              const b = p?.chunk?.block
              if (b && typeof b.text === 'string' && b.text.trim()) { txt = b.text; break }
            }
            aList.push({
              i, turn: data?.turn, step: data?.step,
              hasBlockEnd: Boolean(txt),
              len: txt.length,
              head: txt.slice(0, 40),
            })
          }
          out.assistantList = aList
          const longest = parsed.reduce((a, b) => (b.textLen > a.textLen ? b : a), parsed[0] || { textLen: 0 })
          out.longestLen = longest.textLen
          out.longestBytes = longest.textBytes
          out.longestHead = longest.head
          out.longestTail = longest.tail
          sendJson(res, out)
        } catch (e) {
          out.error = String(e?.message ?? e)
          sendJson(res, out, 500)
        }
      },
    }))

    /**
     * 补挂：把「工作目录是<你的工作区>、但没登记在<你的工作区>名下」的会话挂到<你的工作区>工作区。
     *
     * 背景（10-20 22:40 boss反馈「侧边栏<你的工作区>下面看不到机器人开的会话」）：
     *   建会话时只传了 cwd、没传 workspaceId → DSH 没走 attachSession
     *   （源码 dsh-api-session-controller/lib/index.js:759/776），会话掉进「未分组」。
     *   参数已修（现在传 workspaceId），这个接口补挂**修之前已建的那批**。
     *
     * ⚠️ 走 workspaceRegistry 服务、**不手改 workspace.json**：
     *   手改的话 Host 内存里的账本不跟着变，界面反而读不到
     *   （<你的工作区> 20:35 踩过这个坑）。
     */
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/api/phone-remote/attach-sessions',
      async handler(req, res) {
        try {
          const ws = targetWorkspace()
          if (!ws) {
            sendJson(res, { ok: false, error: '还没选工作区（或工作区 id 变了），补挂不了' }, 404)
            return
          }
          const owned = new Set((ws.sessionIds || []).map(String))
          const wsPath = String(ws.path ?? '')

          // 扫所有活着的会话，挑出「工作目录属于这个工作区、但没挂上」的
          const live = ctx.agents?.list?.() || []
          const targets = []
          for (const a of live) {
            const id = String(a?.id ?? '')
            if (!id || owned.has(id)) continue
            const cwd = String(a?.session?.header?.cwd ?? '')
            if (!cwd.toLowerCase().startsWith(wsPath.toLowerCase())) continue
            targets.push({ id, cwd, isBot: id.startsWith('bot-') })
          }

          const attached = []
          const failed = []
          for (const t of targets) {
            try {
              await ws.attachSession(t.id)
              attached.push(t.id)
            } catch (e) {
              failed.push({ id: t.id, error: String(e?.message ?? e) })
            }
          }
          ctx.logger?.info?.(`phone-remote: 补挂 ${attached.length} 个会话到「${ws.title}」`)
          sendJson(res, { ok: true, workspace: ws.title, attached, failed, total: attached.length })
        } catch (e) {
          sendJson(res, { ok: false, error: String(e?.message ?? e) }, 500)
        }
      },
    }))

    /**
     * 自检：建一个会话 → 看它有没有工具 → 投一句话 → 看有没有回复。
     * ⚠️ 只在本机用（localhost 直连），跟 bot-session 同一个口令。
     *    一次就能验完"新建会话有没有工具"+"投话跑不跑得起来"两件事。
     */
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/api/phone-remote/selftest',
      async handler(req, res) {
        const out = { ok: false }
        try {
          const created = await ctx.sessionController.create({ workspaceId: targetWorkspaceId(), agentPreset: 'standard' })
          out.sessionId = String(created?.sessionId ?? '')
          out.preset = created?.agentPreset ?? null
          if (!out.sessionId) { out.error = '建会话没给 sessionId'; sendJson(res, out); return }

          // 看这个会话的工具量（正常会话 12373，残废会话 253）
          try {
            const a = ctx.agents.get(out.sessionId)
            out.agentFound = Boolean(a)
            out.cwd = a?.session?.header?.cwd ?? ''
            out.presetInHeader = a?.session?.header?.agentPreset ?? null
            const o = ctx.sessionProjections?.stateOf(a?.session, 'contextBreakdown')
            out.toolsTokens = o?.breakdown?.toolsTokens ?? null
            out.phase = a?.phase?.kind ?? null
          } catch (e) { out.probeErr = String(e?.message ?? e) }

          // 投一句话，看多久有回复
          const t0 = Date.now()
          let pr = null
          let prErr = ''
          try {
            const signal = new AbortController().signal
            const second = Object.assign({ kind: 'user' }, {
              throwIfAborted() { signal.throwIfAborted() },
              get aborted() { return signal.aborted },
              addEventListener: (...a) => signal.addEventListener(...a),
              removeEventListener: (...a) => signal.removeEventListener(...a),
            })
            pr = await ctx.sessionController.prompt({
              sessionId: out.sessionId,
              requestId: 'selftest-' + Date.now(),
              mode: 'queue',
              content: [{ type: 'text', text: '只回复两个字：好' }],
            }, second)
          } catch (e) { prErr = String(e?.message ?? e) }
          out.promptOk = Boolean(pr)
          out.promptError = prErr

          // 等回复（最多 120 秒）
          let reply = ''
          const deadline = Date.now() + 120000
          while (Date.now() < deadline) {
            try {
              const a = ctx.agents.get(out.sessionId)
              const o = ctx.sessionProjections?.stateOf(a?.session, 'turnOutline')
              const turns = (o && Array.isArray(o.turns)) ? o.turns : []
              for (let i = turns.length - 1; i >= 0; i--) {
                const r = String(turns[i]?.response || '').trim()
                if (r) { reply = r; break }
              }
            } catch { /* 忽略 */ }
            if (reply) break
            await new Promise((r) => setTimeout(r, 1000))
          }
          out.reply = reply
          out.elapsedS = Math.round((Date.now() - t0) / 1000)
          out.ok = Boolean(reply)
          sendJson(res, out)
        } catch (e) {
          out.error = String(e?.message ?? e)
          sendJson(res, out, 500)
        }
      },
    }))

    /**
     * 探针：把 ctx.agents / sessionController 的真实形状打出来。
     * 只在本机用，配了口令才要口令（不配就本机可达）。
     * ⚠️ 用完可以留着（只读、不干活），排查插件 API 时比翻源码快。
     */
    /**
     * 探针：列出 DSH 里实际可用的模型 + 备用链里每一条**能不能用**。
     * ⚠️ 10-21 09:15 加：换模型前必须先知道链里的模型在 DSH 里存不存在，
     *    不然切过去直接报 session/model-unavailable（白跑一轮）。
     */
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/api/phone-remote/models',
      async handler(req, res) {
        try {
          const out = await listAvailableModels()
          // 顺便报当前默认模型（会话用的是哪个）
          try {
            const adm = typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : (ctx.agentDefaultModel || null)
            out.currentDefault = adm?.currentSelection?.() || null
          } catch (e) {
            out.currentDefaultError = String(e?.message ?? e)
          }
          // selectModel 在不在（换模型的入口）
          out.selectModelType = typeof ctx.sessionController?.selectModel
          sendJson(res, out)
        } catch (e) {
          sendJson(res, { ok: false, error: String(e?.message ?? e) }, 500)
        }
      },
    }))

    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/api/phone-remote/probe',
      async handler(req, res) {
        try {
          const out = { agents: {}, sessionController: {}, sessions: {}, sessionProjections: {} }
          const a = ctx.agents || {}
          out.agents.keys = Object.keys(a)
          out.agents.protoKeys = Object.getOwnPropertyNames(Object.getPrototypeOf(a) || {})
          for (const k of ['list', 'all', 'values', 'entries', 'get', 'ids', 'keys']) {
            const fn = a[k]
            out.agents[k] = typeof fn
            if (typeof fn === 'function' && ['list', 'all', 'values', 'entries'].includes(k)) {
              try {
                const got = fn.call(a)
                const arr = Array.isArray(got) ? got : Array.from(got || [])
                out.agents[k + '_count'] = arr.length
                out.agents[k + '_sample'] = arr.slice(0, 20).map((x) => {
                  const hdr = x?.session?.header
                  return {
                    id: x?.id,
                    topKeys: x && typeof x === 'object' ? Object.keys(x) : typeof x,
                    hdrKeys: hdr && typeof hdr === 'object' ? Object.keys(hdr) : typeof hdr,
                    hdrCwd: hdr?.cwd,
                    optionsCwd: x?.options?.cwd,
                    hdrCwdType: typeof hdr?.cwd,
                    phase: x?.phase,
                    // agent / loop 上到底有哪些方法（找唤醒入口用）
                    agentMethods: Object.getOwnPropertyNames(Object.getPrototypeOf(x) || {}),
                    loopMethods: (() => {
                      try { return Object.getOwnPropertyNames(Object.getPrototypeOf(x?.loopCtx) || {}) } catch { return [] }
                    })(),
                    sendType: typeof x?.send,
                    wakeDriverType: typeof x?.wakeDriver,
                  }
                })
              } catch (e) { out.agents[k + '_error'] = String(e?.message ?? e) }
            }
          }
          const sc = ctx.sessionController || {}
          out.sessionController.keys = Object.keys(sc)
          out.sessionController.protoKeys = Object.getOwnPropertyNames(Object.getPrototypeOf(sc) || {})
          const s = ctx.sessions || {}
          out.sessions.keys = Object.keys(s)
          out.sessions.protoKeys = Object.getOwnPropertyNames(Object.getPrototypeOf(s) || {})
          const sp = ctx.sessionProjections || {}
          out.sessionProjections.keys = Object.keys(sp)
          out.sessionProjections.protoKeys = Object.getOwnPropertyNames(Object.getPrototypeOf(sp) || {})
          sendJson(res, out)        } catch (e) {
          sendJson(res, { error: String(e?.message ?? e) }, 500)
        }
      },
    }))

    /**
     * POST /api/phone-remote/bot-session
     * body: { text: "要让 AI 干的话", token?: "..." }
     *
     * 返回 { ok, sessionId, reply } —— reply 是 AI 这一轮的最终文字回复，
     * 机器人把它原样回进企微会话。
     *
     * ⚠️ 只走 POST，不提供 GET：这个接口会让电脑开会话干活，
     *    不能被浏览器/爬虫随手触发。
     */
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/api/phone-remote/bot-session',
      async handler(req, res) {
        if (String(req.method || 'GET').toUpperCase() !== 'POST') {
          sendJson(res, { ok: false, error: '只接受 POST' }, 405)
          return
        }
        if (!checkToken(req)) {
          sendJson(res, { ok: false, error: '口令不对' }, 401)
          return
        }
        let body
        try {
          body = await readBody(req)
        } catch (e) {
          sendJson(res, { ok: false, error: String(e?.message ?? e) }, 400)
          return
        }
        const text = String(body?.text ?? '').trim()
        if (!text) {
          sendJson(res, { ok: false, error: 'text 不能空' }, 400)
          return
        }

        // ══ 硬闸（boss 2026-10-20 定·永久）══════════════════════════════
        // 「绑定了机器人就必须强制选择工作区作为默认会话的渠道；
        //   如果不选择，不能开启该功能。」
        // 这里放**后端**那道闸：界面拦一道不算数（接口能被人直接调），
        // 所以没选工作区就**一律拒绝干活**，不管请求从哪来。
        const setup = readBotSetup()
        if (setup.bound && !targetWorkspaceId()) {
          sendJson(res, {
            ok: false,
            error: '机器人已绑定，但还没选默认工作区 —— 先在手机远程面板里选一个工作区，这项功能才能用。',
            needWorkspace: true,
          }, 403)
          return
        }
        // ═══════════════════════════════════════════════════════════════

        // 准备接话的会话。
        // boss指定了就用指定的；否则**自己建一个**（不碰 UI 正在管的那些——
        // 往界面开着的会话外部投消息，消息进队列没人取，实测 240 秒超时、
        // 轮次空涨、真会话纹丝不动）。
        let sessionId
        try {
          sessionId = await pickTargetSession()
          if (!sessionId) sessionId = await createBotSession()
        } catch (e) {
          sendJson(res, { ok: false, error: '准备会话失败: ' + String(e?.message ?? e) }, 500)
          return
        }
        if (!sessionId) {
          sendJson(res, { ok: false, error: '建不出会话' })
          return
        }

        let agentError = ''
        // 429 限流标记（模型降级链的触发信号，只判 429——boss 10-20 定）
        let rateLimited = false
        // 降级过程留痕（给诊断用）
        const fallbackTrace = []
        // ⚠️ **测试钩子**（10-21 09:20）：让接口能"假装撞 429"，
        //   用来验证降级链真能work（真撞 429 得等限流，验不了）。
        //   模拟次数 = 头几轮假装 429；之后正常。
        //   ⚠️ 只在本机用（接口本来就只在本机 + 口令）。
        const simRateLimit = Number(body?.simulate429 || 0) || 0
        let simCount = 0

        try {
          // 官方标准动作（dsh-schedule/lib/index.js:1576-1596 同款）：
          // 用 sessionController 拿到那个会话的 agent，再 followup 把话投进去。
          ctx.logger?.info?.(`phone-remote: 准备把话投给会话 ${sessionId}`)
          const resolved = await ctx.sessionController.resolveAgent(sessionId)
          ctx.logger?.info?.(`phone-remote: resolveAgent 返回 keys=${resolved && typeof resolved === 'object' ? Object.keys(resolved).join(',') : typeof resolved}`)
          if (!resolved || 'error' in resolved) {
            sendJson(res, {
              ok: false, sessionId,
              error: '接不上那个会话：' + String(resolved?.error?.message ?? resolved?.error ?? '未知原因'),
            })
            return
          }
          const agent = resolved.agent
          if (!agent || typeof agent.followup !== 'function') {
            ctx.logger?.warn?.(`phone-remote: resolveAgent 没给出可用的 agent（resolved keys=${Object.keys(resolved || {}).join(',')}）`)
            sendJson(res, { ok: false, sessionId, error: '那个会话没有可用的 agent' })
            return
          }
          ctx.logger?.info?.(`phone-remote: 已拿到 agent，准备 followup`)

          // 抓真错误（DSH 内部会静默吞 agent 异常）
          // ⚠️ 10-21 09:20：这里同时**识别 429（限流）**——这是模型降级链的触发信号。
          //   源码依据（10-21 09:15 读 DSH 源码确认，不是猜的）：
          //     dsh-agent-loop/lib/index.js:1021 →
          //       ``error: error instanceof LlmError ? error.failure : {..., code:"UNKNOWN"}``
          //     dsh-llm-deepseek/lib/index.js:1765 →
          //       ``status === 429 || type === 'rate_limit_error'`` → code = "RATE_LIMIT"
          //   所以判据：``code === 'RATE_LIMIT'`` 或 ``status === 429``。
          //   **只判 429**（boss 10-20 定）：模型答错、工具失败、超时都**不**切模型。
          try {
            const actx = agent.ctx
            if (actx && typeof actx.on === 'function') {
              actx.on('agent/error', (e) => {
                const err = e?.error
                agentError = String(err?.message ?? err?.failure?.message ?? err ?? '未知错误')
                // 429 判定：LlmError.failure 里带 code / status
                const code = String(err?.failure?.code ?? err?.code ?? '').toUpperCase()
                const status = Number(err?.failure?.status ?? err?.status ?? 0)
                if (code === 'RATE_LIMIT' || status === 429) {
                  rateLimited = true
                  ctx.logger?.warn?.(
                    `phone-remote: 撞上 429 限流（code=${code || '-'} status=${status || '-'}），` +
                    '准备切备用模型',
                  )
                }
              })
            }
          } catch { /* 挂不上监听不影响主流程 */ }

          // 记一下投进去之前已经跑到第几轮，回头只取新产生的那一轮
          // ⚠️⚠️ **必须在这里就把数字算出来存住**（10-21 01:25 实测踩到）：
          //   `stateOf()` 返回的是**活对象引用**，投话后 DSH 会就地更新它——
          //   所以投话**之后**再读 beforeOutline.turns，拿到的**已经包含新一轮**，
          //   限定就失效了（症状：发出去的是上一轮/英文思考）。
          //   正确做法：投话前算出 maxTurnBefore 这个**数字**，之后只用这个数字。
          let maxTurnBefore = 0
          try {
            const o0 = ctx.sessionProjections?.stateOf(agent.session, 'turnOutline')
            for (const t of (o0?.turns || [])) {
              const n = Number(t?.turn ?? 0)
              if (n > maxTurnBefore) maxTurnBefore = n
            }
          } catch { /* 取不到就退回 0 */ }
          // 投话时刻（毫秒）——产出物的时间闸：只有这之后被改动过的文件才算这轮的
          const promptStartedAt = Date.now()

          // 投话。走 sessionController.prompt —— UI 同款入口，
          // 它自己会构造带 id 的消息、登记轮次、唤醒驱动，一条龙。
          //
          // ⚠️ 签名（源码 dsh-api-session-controller/lib/index.js:925）：
          //     prompt(request: {sessionId, requestId, mode, content}, signal: AbortSignal)
          //   第二个参数是 **AbortSignal**，不是 source！漏了它会报
          //   "signal.throwIfAborted is not a function"（2026-10-20 实测踩到）。
          //   mode: 'steer' 打断当前轮、其它（'queue'）追加到当前轮之后。
          //
          // ⚠️ 为什么不走 agent.followup：它只吃"已经构造好的消息"，
          //   而构造器 @deepseek-ai/dsh-llm 之前没解析到（插件没声明依赖），
          //   手搓的消息没有 id，系统不认它是一轮 → prompt 空、回复空。
          //   （已补 peerDependencies 声明，构造器现已可用，hasCreateUserMessage=true。）
          //   prompt 的 content 参数是**内容块数组**，不用我构造消息，绕开整个问题。
          // ⚠️ 10-21 09:25：投话逻辑挪到下面的 doPrompt() 里（支持 429 降级重投），
          //   这段旧的一次性投话代码删掉，避免两份逻辑打架。
          let promptResult = null
          let promptError = ''
          let fallbackMsgDiag = ''

          // ── 等待：盯「完整回复出现」，不盯别的 ──
          // ⚠️ 2026-10-20 实测踩过的坑：
          //   ① agent.whenIdle() 不能用：会话本来 idle，它当场兑现（0.3 秒返回），
          //      而模型还没开始跑。
          //   ② 轮次变长也不能当"跑完了"：消息被**接纳**时轮次就长了，
          //      但 prompt 记录还是空的、模型还没动。
          //   ③ **不能拿 turnOutline 的 response 当回复**——它只存 120 字符摘要，
          //      boss实测要 500 字、回来正好 120 字带「…」（10-20 23:27 反馈的截断）。
          //      完整回复走 fetchFullReply()（sessionController.page 给全量事件）。
          //   ④ **必须限定 turn**——page 给的是整个会话历史，最后一条 assistant
          //      可能是**上一轮**的旧回复；不限定就会把旧回复当成新的发出去。
          // 所以这里死等：**这一轮的完整回复**出现才算跑完，超时才算失败。
          //
          // ⚠️ 10-21 09:25 加：**429 自动降级**（模型链）。
          //   命中 429 → 换下一个模型 → **重投这一轮的话** → 再等。
          //   只判 429（boss 10-20 定）；链走完还 429 → 报错给boss。
          const chain = readFallbackChain()
          let rawReply = ''
          let usedModel = null
          let chainIndex = -1

          // 投一次话（可重复调用：降级后重投）
          const doPrompt = async (tag) => {
            const signal = new AbortController().signal
            const second = Object.assign(
              { kind: 'user' },
              {
                throwIfAborted() { signal.throwIfAborted() },
                get aborted() { return signal.aborted },
                addEventListener: (...a) => signal.addEventListener(...a),
                removeEventListener: (...a) => signal.removeEventListener(...a),
                onabort: null,
                reason: signal.reason,
              },
            )
            try {
              const r = await Promise.race([
                ctx.sessionController.prompt({
                  sessionId,
                  // ⚠️ requestId 必须**每次不同**——源码 hasPromptRequest() 会拒重复的 id
                  requestId: 'bot-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '-' + tag,
                  mode: 'queue',
                  content: [{ type: 'text', text: BOT_TEXT_ONLY_PREFIX + text }],
                }, second),
                new Promise((_, rej) => setTimeout(() => rej(new Error('投话超时(30s)')), 30000)),
              ])
              return { ok: Boolean(r), error: '' }
            } catch (e) {
              const msg = String(e?.message ?? e)
              ctx.logger?.warn?.('phone-remote: sessionController.prompt 报错: ' + msg)
              return { ok: false, error: msg }
            }
          }

          // 切到链里的下一个模型
          const switchModel = async (idx) => {
            const f = chain[idx]
            if (!f) return false
            try {
              await ctx.sessionController.selectModel({
                sessionId, provider: f.provider, model: f.model,
              })
              usedModel = f
              chainIndex = idx
              fallbackTrace.push({ to: f.label, provider: f.provider, model: f.model })
              ctx.logger?.info?.(`phone-remote: 已切到备用模型 ${f.label}`)
              return true
            } catch (e) {
              ctx.logger?.warn?.(`phone-remote: 切模型失败 ${f.label}: ${String(e?.message ?? e)}`)
              fallbackTrace.push({ to: f.label, failed: String(e?.message ?? e) })
              return false
            }
          }

          /** 找下一个「跟当前用的不一样」的链位置。 */
          const nextModelIndex = async (from) => {
            let cur = null
            try {
              const adm = typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : (ctx.agentDefaultModel || null)
              cur = adm?.currentSelection?.() || null
            } catch { /* 取不到就当没有 */ }
            const curProvider = String(cur?.provider ?? '').trim()
            const curModel = String(cur?.model ?? '').trim()
            for (let i = Math.max(0, from); i < chain.length; i++) {
              const f = chain[i]
              // ⚠️ 跳过跟当前**完全一样**的（切过去等于没切）
              if (curProvider && f.provider === curProvider && f.model === curModel) continue
              return i
            }
            return -1
          }

          let attempt = 0
          let promptOk = false
          while (attempt <= chain.length) {
            attempt++
            rateLimited = false
            // 这一轮的 turn 基准（降级重投要用**新的**基准）
            const turnBase = maxTurnBefore
            const pr = await doPrompt('a' + attempt)
            promptOk = promptOk || pr.ok
            promptResult = pr.ok ? { accepted: true } : null
            promptError = pr.error || ''
            if (!pr.ok && !pr.error.includes('超时')) {
              // 投话就失败（非超时）→ 不用等，直接进下一轮尝试
            }

            const deadline = Date.now() + BOT_RUN_TIMEOUT_MS
            rawReply = ''
            // ⚠️ 测试钩子：这轮假装撞 429
            //   ⚠️ 必须**跳过取回复**——否则 fetchFullReply 会拿到**上一轮的旧回复**
            //   （实测：模拟 429 时立刻返回了 146 字的上一轮内容，降级根本没触发）。
            let simulating = false
            if (simRateLimit > 0 && simCount < simRateLimit) {
              simCount++
              rateLimited = true
              simulating = true
              ctx.logger?.info?.(`phone-remote: [测试] 假装撞 429（第 ${simCount}/${simRateLimit} 次）`)
            }
            while (Date.now() < deadline) {
              if (!simulating) {
                rawReply = await fetchFullReply(sessionId, turnBase)
                if (rawReply) break
              }
              // 撞 429 就别死等 —— 立刻换模型重投
              if (rateLimited) break
              await new Promise((r) => setTimeout(r, 1000))
            }
            if (rawReply) break
            if (!rateLimited) {
              ctx.logger?.warn?.(`phone-remote: 等了 ${Math.round(BOT_RUN_TIMEOUT_MS / 1000)} 秒没等到回复`)
              break
            }
            // 撞 429 → 切下一个模型
            const fromIdx = chainIndex + 1
            const nextIdx = await nextModelIndex(fromIdx)
            if (nextIdx < 0) {
              ctx.logger?.warn?.('phone-remote: 429 且备用模型链已走完（或剩下的都是当前模型）')
              break
            }
            const ok = await switchModel(nextIdx)
            if (!ok) {
              // 这个模型切不过去 → 试下一个
              let j = nextIdx + 1
              while (j < chain.length && !ok) { ok = await switchModel(j); j++ }
              if (!ok) break
            }
            // ⚠️ 重投前**刷新 turn 基准**：上一轮虽然失败了，但 DSH 可能已经
            //   把它记成一轮了 → 基准不刷新会取到"上一轮"的空回复。
            try {
              const oN = ctx.sessionProjections?.stateOf(agent.session, 'turnOutline')
              let mx = maxTurnBefore
              for (const t of (oN?.turns || [])) {
                const n = Number(t?.turn ?? 0)
                if (n > mx) mx = n
              }
              maxTurnBefore = mx
            } catch { /* 读不到就用旧值 */ }
            ctx.logger?.info?.(`phone-remote: 429 降级，第 ${attempt + 1} 次尝试（模型 ${usedModel?.label}）`)
          }
          // 净化：把卡片 JSON 剥掉，只留人话（10-20 22:20 boss收到一坨乱码的根因）
          const reply = sanitizeReply(rawReply)
          if (rawReply && reply !== rawReply) {
            ctx.logger?.info?.('phone-remote: 回复里含卡片格式，已剥离成纯文字')
          }

          const reallyRan = reply.length > 0
          const freshTurnsNow = []

          // 诊断信息一并回给调用方（机器人只是转发，真正要看的是我）。
          // 这段是临时的排查脚手架，定位完成后删。
          const diag = {
            sessionId,
            replyLen: reply.length,
            replyBytes: Buffer.byteLength(reply, 'utf8'),
            agentError: agentError || '',
            hasKick: typeof agent.kick === 'function',
            hasWakeDriver: typeof agent.wakeDriver === 'function',
            phaseKind: (() => { try { return agent.phase?.kind } catch { return '?' } })(),
            phaseTurn: (() => { try { return agent.phase?.turn ?? agent.phase?.lastTurn } catch { return '?' } })(),
            hasCreateUserMessage: typeof createUserMessage === 'function',
            promptOk: Boolean(promptResult) || promptOk,
            promptError: promptError || '',
            fallbackMsg: fallbackMsgDiag || '',
            // ── 模型降级链留痕（10-21 09:25 加）──
            rateLimited,
            chainSize: chain.length,
            attempts: attempt,
            usedModel: usedModel ? usedModel.label : '',
            fallbackTrace,
          }

          if (!reallyRan) {
            sendJson(res, {
              ok: false, ...diag,
              error: '话投进去了，但这一轮没跑出内容' + (agentError ? '（原因：' + agentError + '）' : ''),
            })
            return
          }

          ctx.logger?.info?.(`phone-remote: 已投给会话 ${sessionId}，本轮回复 ${reply.length} 字`)

          // 收集这一轮的产出文件（boss 01:00 定的 A1：新写/改过/明确交付的都发）
          // ⚠️ 用**投话时刻**做时间闸：只有这之后被改动过的文件才算这轮的产出
          //   （presented 事件不带 turn，按 turn 过滤不掉旧文件——实测踩过）。
          let files = []
          try {
            files = await collectProducedFiles(sessionId, promptStartedAt, maxTurnBefore)
            ctx.logger?.info?.(`phone-remote: 本轮产出文件 ${files.length} 个: ${files.map((f) => f.name).join(', ')}`)
          } catch (e) {
            ctx.logger?.warn?.('phone-remote: 收集产出文件出错: ' + String(e?.message ?? e))
          }

          sendJson(res, { ok: true, ...diag, reply, files })
        } catch (e) {
          ctx.logger?.warn?.('phone-remote: 投话给会话失败: ' + String(e?.message ?? e))
          sendJson(res, {
            ok: false, sessionId,
            error: String(e?.message ?? e) + (agentError ? '（原因：' + agentError + '）' : ''),
          }, 500)
        }
      },
    }))

    return () => { for (const d of disposers) { try { d() } catch { /* 清理失败不该拦住卸载 */ } } }
  })

  ctx.effect(() => () => {
    if (idleTimer) clearInterval(idleTimer)
  })
}
