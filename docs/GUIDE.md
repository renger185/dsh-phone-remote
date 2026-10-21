# 引导说明（从零到跑通）

> 面向"照着做就能用"的读者。全程不需要买域名、不需要改路由器、不需要云服务器。
> 平台差异只影响两个地方：**推送出口**与**收信入口**（见第 2、5 步的平台表）。

---

## 0. 前置条件

| 项 | 要求 |
|---|---|
| DSH | 桌面版或 `dsh web` 实例**正在运行**（Web 界面能打开） |
| Node.js | 18+（示例用 20/22 均可）；`node -v` 能出版本 |
| 插件管理器 | 能对目标 profile 执行 `install_bundle` |
| 网络 | 电脑能出网（推送、下载程序、长连接都需要） |
| 手机 | 与电脑同 WiFi（第 1 条）；有流量（第 3、4 条） |

> 三块能力可以只用其中一块：
> **只想要"手机看界面"** → 做第 1、3 步；
> **还想要"跑完提醒"** → 加第 2 步；
> **还想要"在外面也能召唤"** → 加第 4、5 步。

---

## 1. 装插件

把 `plugin/` 目录交给插件管理器装载（目标指向**这个目录的绝对路径**）。

- 装载后确认：
  - 插件行已启用；
  - **刷新页面**（客户端模块清单在页面启动时固定），左下角出现「手机远程」按钮；
  - 设置 → 插件 列表里能看到本插件。
- 如果"装成功了但看不到面板"：检查 `package.json` 里**有没有** `dsh.client` 段，
  有的话**重新装载一次**再刷新（见 `docs/PITFALLS.md` 第 9 条）。

## 2. 配"推送出口"（发通知）

插件干完活要往手机推一条，出口是一个**接受 `POST` JSON 的 Webhook 地址**。
在插件配置里给 `pushWebhook`（或按平台的等价字段）即可，**平台无关**。

| 平台 | 拿地址的地方 | 请求体（`POST` JSON） |
|---|---|---|
| 企业微信群机器人 | 群设置 → 群机器人 → Webhook 地址 | `{"msgtype":"markdown","markdown":{"content":"**标题**\n正文\n[打开](url)"}}` |
| 飞书自定义机器人 | 群设置 → 机器人 → Webhook | `{"msg_type":"text","content":{"text":"标题\n正文"}}` |
| 钉钉自定义机器人 | 群设置 → 智能群助手 → Webhook | `{"msgtype":"markdown","markdown":{"title":"标题","text":"正文"}}` |
| ntfy | `https://ntfy.sh/<你的频道>` | `{"topic":"<频道>","title":"标题","message":"正文","click":"url"}` |

> **脱敏提示**：Webhook 地址本身就是凭据（含 key），**不要写进公开仓库**。
> 用 `config.example.yml` 的占位符写法，真实值只放在本机、且被 `.gitignore` 排除。

## 3. 起"传达室"（同 WiFi 直接用手机浏览器）

`phone-proxy.mjs`：监听 `0.0.0.0:51130`，把手机请求转给 DSH 的 loopback 端口，
并**改写 `Host` 与 `Origin`**（见 `PITFALLS.md` 第 6 条）。

```bash
node phone-proxy.mjs            # 前台试跑，确认能通
curl -i http://<你的局域网IP>:51130/      # 期望 302（自动续钥匙）或 401
```

**必须交给系统托管**，否则主程序一重启它就被连坐杀掉（`PITFALLS.md` 第 4 条）：

- Windows（计划任务，实测有效）：
  ```
  schtasks /Create /TN "<任务名>" /SC ONLOGON /RL LIMITED ^
    /TR "\"<node.exe路径>\" \"<绝对路径>\phone-proxy-supervisor.mjs\""
  ```
  或 PowerShell `Register-ScheduledTask`，设置 `RestartCount/Interval`、`ExecutionTimeLimit=0`、`Hidden`。
- Linux：`systemd` 单元（`Restart=always`）。
- macOS：`launchd`（`KeepAlive`）。

### 让它更省心：保活壳 + 上游自适应

- `phone-proxy-supervisor.mjs`：崩了 3 秒重启；发现端口已被别人占用就**自动让位**（避免重复启动）。
- `upstream.json`：由插件在激活时写入当前 DSH 端口。代理定时读它 → **DSH 换端口自动跟随**。
- `login-link.txt`：插件写入的"带钥匙入口链接"。代理在访客**没有登录票据**时自动续钥匙（见安全权衡）。

## 4. 临时限时门（出门用流量）

`temp-door.mjs`：起一条公网 HTTPS 隧道指向传达室，把地址推给手机，**到点自动关**。

```bash
node temp-door.mjs --minutes 30     # 开 30 分钟
node temp-door.mjs --minutes 3      # 开 3 分钟（用完即焚）
node temp-door.mjs --close          # 立即关
```

### 依赖：cloudflared（或同类隧道客户端）

国内下载常见坑：GitHub Release 直连被重置 → **换镜像下载 + 必须验签**：

```powershell
# 1) 换镜像下载（示例镜像，可自行替换）
curl.exe -L -o cloudflared.exe "https://<镜像>/https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
# 2) 验签（关键！签名者必须是 Cloudflare, Inc.）
Get-AuthenticodeSignature .\cloudflared.exe | Select-Object Status, @{n='Signer';e={$_.SignerCertificate.Subject}}
# 3) 记录哈希留痕
Get-FileHash .\cloudflared.exe -Algorithm SHA256
```

**判据**：`Status = Valid` 且签发者是官方 → 才使用。**借道镜像 ≠ 借道信任。**

## 5. 机器人长连接（在外面也能召唤）

目的：手机发一句话给机器人 → 电脑收到 → 开门/干活 → **把结果回进同一个会话**。
**不需要任何公网地址**——客户端主动连出去。

| 平台 | 凭据 | 长连接 |
|---|---|---|
| 企业微信「智能机器人」 | Bot ID + Secret | 官方 SDK `@wecom/aibot-node-sdk`（`wss://openws.work.weixin.qq.com`） |
| 飞书自建应用 | App ID + App Secret | 开放平台事件订阅选「长连接」 |
| QQ 机器人 | Bot ID + Secret (+Token) | 开放平台 WebSocket |

企业微信示例（最小可用）：

```js
import AiBot, { generateReqId } from '@wecom/aibot-node-sdk'
const client = new AiBot.WSClient({ botId: '<BotId>', secret: '<Secret>' })
client.on('authenticated', () => console.log('在线'))
client.on('message.text', async (frame) => {
  const text = frame?.body?.text?.content ?? ''
  const streamId = generateReqId('stream')
  await client.replyStream(frame, streamId, `收到：${text}`, true)
})
client.connect()
```

要点：
- 同样**交给计划任务/systemd 托管**（断线自动重连由 SDK 负责，进程本身也要保活）；
- 凭据放**本机文件**并 `.gitignore`，别提交；
- 收到「开门」这类指令时，调用 `temp-door.mjs` 拿到链接，再**回进会话**。

---

## 6. 验证清单（电脑侧与真机侧分开）

**电脑侧（能自动化验证的）**

- [ ] 代理：`curl http://<局域网IP>:51130/` → `302`（自动续钥匙）或 `401`
- [ ] 带钥匙：`curl -L "<带token的链接>"` → 最终 `200`，页面大小与主界面一致
- [ ] WebSocket：代理日志出现 `upgrade ok`
- [ ] 临时门：开门后 `curl <公网地址>/` → `302 → 200`；到点后 → `530`（隧道已灭）
- [ ] 收件端点（若用回调模式）：无签名 `403`、乱路径 `404`
- [ ] 机器人：日志出现"认证成功"；发消息后有"收到文本"记录
- [ ] 保活：手动 kill 子进程 → 3 秒内自动恢复；重复启动 → 后启动者让位

**真机侧（只有人能验证）**

- [ ] 手机同 WiFi 点通知链接 → 能进界面、能派活
- [ ] 手机（流量）点**通知里的链接** → 也能进界面（v0.3.0 起通知带的就是公网链接）
- [ ] 手机（流量）点临时门链接 → 能进界面
- [ ] 手机给机器人发「开门」→ 会话里收到链接 → 点开可用
- [ ] 任务跑完 → 手机收到提醒
- [ ] **重启电脑后**：机器人仍在线、发「开门」仍有效
- [ ] **拔掉家里 WiFi 只留流量**：点最新一条通知链接 → 能进（这条专治"内网地址出门打不开"）

> 诚实提示：电脑侧全绿 **不代表**真机可用。第 13 条踩坑就是这么来的。

---

## 7. 排障速查

| 症状 | 先看 | 常见原因 |
|---|---|---|
| 手机打不开（同 WiFi） | 代理日志有没有 `listening` | 代理没起 / 端口被占 / 防火墙 |
| 页面 403 | 是否只有 WebSocket 失败 | 只改了 `Host` 没改 `Origin` |
| 平台后台"地址回填不通过" | 是否用了回调模式 | `echostr` 要回**解密后的明文** |
| 电脑重启后平台收不到消息 | 是否用了回调模式 | 快速隧道换域名了 → **改用长连接** |
| 常驻进程莫名消失 | 日志有没有"崩溃重启"记录 | 被会话作业对象连坐 → **改计划任务** |
| 面板看不到 | 页面 HTML 里有没有插件包名 | 缺 `dsh.client` / DSH 没重启 / 页面没刷新 |
| 回消息报 `41004` | 配置里有没有 `secret` | 只配了收消息的 Token/AESKey |
| 下载安装包卡住/0 字节 | 是否直连 GitHub | 换镜像 + **验签** |
| **通知里的链接出门打不开** | 链接里是不是局域网 IP | v0.3.0 起通知自动带公网链接；老版本请升级（见 `PITFALLS.md` 第 17 条） |
| **门"开了"但点开是 530** | 开门日志有没有 `Registered tunnel connection` | 只看到地址≠连上；必须"地址+注册"齐了才算成（见 `PITFALLS.md` 第 15 条） |
| **机器人进程在、消息收不到** | 自检日志的 `isConnected` | 长连接静默假死；自检连续未见连接要能自动重连/重启（见 `PITFALLS.md` 第 16 条） |
| **"门已关闭"提醒从没收到过** | 关门前有没有 await 推送 | 推送没 await 就被 `process.exit()` 打断（见 `PITFALLS.md` 第 18 条） |

---

## 8. 通知里的链接从哪来（v0.3.0 起）

发通知（任务跑完 / 出错 / 入口更新）时，插件按这个顺序拿链接：

1. 读本机 `door-state.json`，**现成的门还剩 ≥10 分钟** → 直接复用它的公网地址（不多开门）；
2. 否则**自动开一扇 30 分钟的门**（`temp-door.mjs --minutes 30 --quiet`，
   `--quiet` 表示门自己不再推消息，免得一条通知变两条），等它写出门状态后取公网地址；
3. 门没开成（连试 3 次都不行）→ **通知照发，但不带链接**，正文里说明一句；
   **绝不推一条点不开的死链接**。

相关配置：`doorScript` / `doorStateFile` / `doorMinutes` / `doorMinRemainingMs` / `doorOpenTimeoutMs`
（默认取 `linkFile` 同目录，通常不用配）。安全影响见 `docs/SECURITY.md` 第 2.1 节。
