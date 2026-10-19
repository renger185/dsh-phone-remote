# 企业微信部署教程（Phone Remote）

> 跟着做就能得到一个完整闭环：
> **手机企微发一句「开门」→ 电脑开一扇限时门 → 链接直接回到企微会话 → 点开用浏览器干活**；
> 另外还包含"任务跑完提醒"与"同 WiFi 直接开界面"。
>
> 本文所有密钥一律写成占位符（`<YOUR_...>`），**照抄不会泄漏任何人的凭据**。
> 通用原理与避坑见 [ARCHITECTURE.md](ARCHITECTURE.md) / [PITFALLS.md](PITFALLS.md)。
> Language: **中文** · [English](TUTORIAL-WECOM.en.md)

---

## 0. 你需要准备什么

| 项 | 说明 |
|---|---|
| 企业微信**管理员**权限 | 要建群机器人 + 建智能机器人 |
| 一台常开的电脑 | 跑 DSH（桌面版或 `dsh web`） |
| Node.js 18+ | `node -v` 验证 |
| 手机 | 装企业微信，与电脑同一组织 |
| 约 40 分钟 | 主要是等下载和配置 |

**两条路先分清**（本文走①）：

| | ① 智能机器人（本文） | ② 自建应用 |
|---|---|---|
| 收消息 | **长连接**，电脑主动连出去 | 平台推到一个**公网回调 URL** |
| 要不要固定公网地址 | **不要** | **要**（家庭宽带做不到，勿入坑） |
| 要填的凭据 | `Bot ID` + `Secret` | `Token` + `EncodingAESKey` + `Secret` |

> 判别方法：如果配置页面出现「**接收消息 URL / Token / EncodingAESKey**」，那是②，别走；
> 出现「**Bot ID / Secret**」并可选择长连接模式的，才是①。

---

## 1. 装插件

把 `plugin/` 目录交给 DSH 的插件管理器装载（`install_bundle`，目标＝该目录绝对路径）。

装载后确认三件事：

1. 插件行已启用；
2. **刷新页面**（客户端模块清单在页面启动时固定），左下角出现「📱 指挥台」；
3. 设置 → 插件 里能看到本插件。

> 若"装成功但看不到面板"：检查 `package.json` 里有没有 `dsh.client` 段；补上后**重新装载一次**再刷新。
> （详见 `PITFALLS.md` 第 9 条）

---

## 2. 配推送出口：企业微信「群机器人」

### 2.1 拿到 Webhook 地址

1. 企业微信里**建一个只有你自己的群**（或"文件传输助手"式的私密群）；
2. 群右上角 → **群机器人** → **添加机器人** → 创建；
3. 复制生成的 **Webhook 地址**，形如：

```
https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=<YOUR_WECOM_WEBHOOK_KEY>
```

> ⚠️ 这个地址本身就是凭据（含 key）。**不要发到公开群、不要提交到仓库。**

### 2.2 填进插件配置

参考 `config.example.yml`，把真实值填进你本机的 patch（**该文件已被 `.gitignore` 排除**）：

```yaml
pushWebhook: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=<YOUR_WECOM_WEBHOOK_KEY>'
```

### 2.3 验证推送

手动发一条，看到 HTTP 200 且返回 `{"errcode":0,"errmsg":"ok"}` 即通：

```bash
curl -s -X POST -H "Content-Type: application/json" \
  --data '{"msgtype":"text","text":{"content":"【测试】推送通道已通"}}' \
  'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=<YOUR_WECOM_WEBHOOK_KEY>'
```

---

## 3. 起「传达室」：同 WiFi 手机直接开界面

```bash
node phone-proxy.mjs      # 前台试跑
curl -i http://<YOUR_LAN_IP>:51130/     # 期望 302（自动续钥匙）或 401
```

**必须交给系统托管**（否则主程序重启会把它连坐杀掉，见 `PITFALLS.md` 第 4 条）。Windows 计划任务：

```powershell
$node = "<node.exe 绝对路径>"
$script = "<WORKSPACE_DIR>\phone-proxy-supervisor.mjs"
$action  = New-ScheduledTaskAction -Execute $node -Argument ('"' + $script + '"') -WorkingDirectory "<WORKSPACE_DIR>"
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew -Hidden
Register-ScheduledTask -TaskName "DshPhoneProxy" -Action $action -Trigger $trigger -Settings $settings -Force
Start-ScheduledTask -TaskName "DshPhoneProxy"
```

验证血缘（父进程应是任务计划服务，不是你的终端）：

```powershell
$p = Get-NetTCPConnection -State Listen -LocalPort 51130 | Select-Object -First 1
(Get-CimInstance Win32_Process -Filter "ProcessId=$($p.OwningProcess)").ParentProcessId | % {
  (Get-CimInstance Win32_Process -Filter "ProcessId=$_").Name }   # 期望 svchost
```

此时手机（同 WiFi）打开 `http://<YOUR_LAN_IP>:51130/` 就能用了。

---

## 4. 出门用：临时限时门

### 4.1 准备隧道客户端（cloudflared）

国内直连 GitHub 常被重置，**换镜像下载 + 必须验签**：

```powershell
curl.exe -L -o cloudflared.exe "https://<镜像域名>/https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
Get-AuthenticodeSignature .\cloudflared.exe | Select-Object Status, @{n='Signer';e={$_.SignerCertificate.Subject}}
# 判据：Status = Valid，且 Signer 为 "Cloudflare, Inc." 才使用
Get-FileHash .\cloudflared.exe -Algorithm SHA256      # 留痕
```

### 4.2 开关门

```bash
node temp-door.mjs --minutes 30     # 开 30 分钟（出门常用）
node temp-door.mjs --minutes 3      # 开 3 分钟（用完即焚）
node temp-door.mjs --close          # 立即关
```

开门后会往企微群推一条带链接的消息；**到点自动关、链接作废**。

> 安全提醒：门开着期间，**拿到该网址的人不需要口令就能进**（为了让"点通知即进"成立）。
> 所以：只发私密群、只开短期、用完即关。要更强隔离可以加门卫口令（见 `SECURITY.md`）。

---

## 5. 核心：企业微信「智能机器人」长连接（在外面也能召唤）

### 5.1 在企业微信后台创建智能机器人

1. 企业微信**管理后台** → 找到「机器人 / 智能机器人」入口（不同版本菜单名略有差异，
   可在后台搜索"机器人"）；
2. 创建一个机器人，记下它的 **Bot ID** 与 **Secret**；
3. 确认走**长连接**模式（不需要填任何回调 URL）。

拿到后形如：

```
Bot ID : <YOUR_BOT_ID>
Secret : <YOUR_BOT_SECRET>
```

> 想看它在哪聊天：把它加入一个只有你自己的群，或在机器人的会话里直接对话。

### 5.2 装官方 SDK

```bash
mkdir bot && cd bot
# 国内建议走镜像源，速度差很多
pnpm add @wecom/aibot-node-sdk --registry=https://registry.npmmirror.com
# 或 npm i @wecom/aibot-node-sdk --registry=https://registry.npmmirror.com
```

### 5.3 写机器人脚本（凭据走本机文件，不硬编码）

**`bot/wecom-bot.json`**（**不入库**，已被 `.gitignore` 排除）：

```json
{ "botId": "<YOUR_BOT_ID>", "secret": "<YOUR_BOT_SECRET>" }
```

**`bot/wecom-bot.mjs`**（最小可用版）：

```js
import AiBot, { generateReqId } from '@wecom/aibot-node-sdk'
import fs from 'node:fs'
import { spawn } from 'node:child_process'

const cfg = JSON.parse(fs.readFileSync(new URL('./wecom-bot.json', import.meta.url), 'utf8'))
const client = new AiBot.WSClient({ botId: cfg.botId, secret: cfg.secret })

client.on('authenticated', () => console.log('✅ 长连接认证成功，机器人已在线'))

client.on('message.text', async (frame) => {
  const text = frame?.body?.text?.content ?? ''
  const streamId = generateReqId('stream')
  if (text.includes('开门')) {
    await client.replyStream(frame, streamId, '收到，正在开门…', false)
    const link = await openDoor(30)                    // 见下：起临时门并解析出公网地址
    await client.replyStream(frame, streamId,
      link ? `**临时门已开（30 分钟）**\n[点此打开](${link})` : '开门失败，请看电脑日志。', true)
  } else {
    await client.replyStream(frame, streamId, `收到：${text}`, true)
  }
})

// 起临时门并取回公网地址（复用 temp-door.mjs）
// ⚠️ 不要从子进程输出里"抓第一个地址"：temp-door 现在是先建隧道、再从公网侧自测，
//    自测不过会换一条重来；抓早了会把**作废地址**回给用户（见 PITFALLS.md 第 15 条）。
//    正确做法：读 temp-door 写下的 door-state.json，且只认"刚开的这一扇"。
function openDoor(minutes) {
  const stateFile = new URL('./door-state.json', import.meta.url)
  const startedAt = Date.now()
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['../temp-door.mjs', '--minutes', String(minutes)], { windowsHide: true })
    let done = false
    const finish = (v) => { if (!done) { done = true; clearInterval(timer); resolve(v) } }
    const timer = setInterval(() => {
      try {
        const s = JSON.parse(readFileSync(stateFile, 'utf8'))
        const openedAt = Date.parse(s?.openedAt ?? '')
        if (s?.url && Number.isFinite(openedAt) && openedAt >= startedAt - 5000) finish(s.url)
      } catch {}
    }, 1000)
    child.on('error', () => finish(null))
    child.on('exit', () => finish(null))
    setTimeout(() => finish(null), 90000)
  })
}

client.connect()
```

> 上面 `../temp-door.mjs` 与 `new URL('./wecom-bot.json', ...)` 是相对路径，按你的实际布局调整。

### 5.4 交给计划任务托管

```powershell
$action  = New-ScheduledTaskAction -Execute "<node.exe 绝对路径>" `
  -Argument ('"' + "<WORKSPACE_DIR>\bot\wecom-bot.mjs" + '"') -WorkingDirectory "<WORKSPACE_DIR>\bot"
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew -Hidden
Register-ScheduledTask -TaskName "DshWecomBot" -Action $action -Trigger $trigger -Settings $settings -Force
Start-ScheduledTask -TaskName "DshWecomBot"
```

看日志确认：

```
[....] 机器人启动，正在连接企业微信长连接…
[....] ✅ 长连接认证成功，机器人已在线（不依赖任何公网地址）
```

### 5.5 测试

在企微里找到该机器人，发一句 **「开门」**。预期：

1. 秒回「收到，正在开门…」
2. 十几秒后回「**临时门已开（30 分钟）**」+ 可点链接

---

## 6. 可选：让正文真去干活

现在只有「开门」是实动作，其他文本只回显。要接成"发什么都真执行"，
在 `message.text` 里把文本转发给 DSH 的会话（例如调用会话控制接口下发一条用户消息），
再把结果回进企微会话。这部分属于上层扩展，按你的 DSH 版本对应的接口实现即可。

---

## 7. 验收清单

**电脑侧（可自动化）**

- [ ] 推送：`curl` 企微 webhook → `errcode:0`
- [ ] 传达室：`curl http://<YOUR_LAN_IP>:51130/` → `302/401`；带钥匙链接 → 最终 `200`
- [ ] 代理日志出现 `upgrade ok`（WebSocket 通）
- [ ] 临时门：开门后公网地址 `302 → 200`；到点后 `530`
- [ ] 机器人：日志出现「认证成功」；发消息后有「收到文本」
- [ ] 保活：kill 子进程 → 秒级自愈；重复启动 → 后来者让位

**真机侧（只有人能验）**

- [ ] 同 WiFi 点通知链接 → 能进界面、能派活
- [ ] **关掉 WiFi 只留流量**，点**通知里的链接** → 能进界面（v0.3.0 起通知自动带公网链接）
- [ ] 流量环境点临时门链接 → 能进界面
- [ ] 企微发「开门」→ 会话内收到链接 → 可打开
- [ ] 任务跑完 → 收到提醒（且链接外面点得开）
- [ ] **重启电脑后**：机器人仍在线、「开门」仍有效

---

## 8. 企微专属故障对照

| 症状 | 根因 | 处置 |
|---|---|---|
| 群里发消息机器人收不到 | 群机器人**只能发不能收** | 换**智能机器人**长连接（本文第 5 节） |
| 后台保存回调 URL 报"回填不通过" | 该模式要求回**解密后的明文** `echostr` | 改用长连接；或按 `PITFALLS.md` 第 2 条修 |
| 电脑重启后企微收不到消息 | 用了回调模式，快速隧道换了域名 | 改用长连接（**不要**再去买域名凑） |
| 回消息报 `errcode 41004` | 缺 `Secret`（只配了 Token/AESKey） | 补齐凭据 |
| 推送没到手机 | 群机器人被移除 / 手机通知权限关了 | 群里看机器人是否还在；检查系统通知 |
| 电脑重启后面板消失 | 插件 Host 半没起来 | 查插件行是否启用、计划任务是否在跑 |
| **通知里的链接出门打不开** | 老版本通知里放的是局域网地址（出门在公网不存在） | 升到 **v0.3.0**：通知自动开一扇 30 分钟的门、带公网链接（`PITFALLS.md` 第 17 条） |
| **门"开了"但点开 530 / 转圈** | 只看到公网地址、隧道其实没连上 | 升级 `temp-door.mjs`：要"地址+`Registered tunnel connection`"，还要公网侧实拨一次（`PITFALLS.md` 第 15 条） |
| **机器人常在线却收不到消息** | 长连接静默假死 | 用带自检自愈的 `wecom-bot.mjs`：未连接 2 分钟重连、5 分钟未连接就退出重拉（`PITFALLS.md` 第 16 条） |

---

## 9. 脱敏清单（企微场景专属）

提交到公开仓库前，确认以下**真实值**一个都不在仓库里：

| 项 | 长什么样 | 换成 |
|---|---|---|
| 群机器人 Webhook | `.../webhook/send?key=<uuid>` | `<YOUR_WECOM_WEBHOOK_KEY>` |
| 智能机器人 Bot ID | 平台分配的长串 | `<YOUR_BOT_ID>` |
| 智能机器人 Secret | 随机长串 | `<YOUR_BOT_SECRET>` |
| 企业 ID / 应用 Secret（若用自建应用） | `ww...` / 随机长串 | `<YOUR_CORP_ID>` / `<YOUR_APP_SECRET>` |
| 企微 userid | 常是姓名拼音 | `<YOUR_USER_ID>` |
| 内网 IP / 工作目录 | `192.168.x.x` / 个人路径 | `<YOUR_LAN_IP>` / `<WORKSPACE_DIR>` |

自检命令与更多细节见 [SECURITY.md](SECURITY.md) 第 5 节（**拿自己的真实值反查，全部应为无命中**）。
