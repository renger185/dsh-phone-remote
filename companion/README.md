# companion/ — 三个配套小服务（发布副本）

> 这三个脚本**可选**：只用插件也能跑"手机看界面 + 跑完提醒"。
> 需要"出门用流量"就加临时门；需要"在外面发一句话召唤"就加机器人。

## 文件

| 文件 | 作用 | 依赖 |
|---|---|---|
| `phone-proxy.mjs` | 传达室：`0.0.0.0:51130` → 本机 DSH 的 loopback 端口；改写 `Host`/`Origin`；无登录票据时自动续钥匙 | 无 |
| `phone-proxy-supervisor.mjs` | 保活壳：子进程崩了 3 秒重启；端口已被占用则自动让位 | 无 |
| `temp-door.mjs` | 临时限时门：起公网 HTTPS 隧道指向传达室，到点自动关 | `cloudflared`（需自行下载并**验签**） |
| `wecom-bot.mjs` | 机器人长连接：收到「开门」→ 开临时门 → 把链接回进会话（示例为企业微信） | `@wecom/aibot-node-sdk` |

## 安装与运行

```bash
# 1) 传达室（建议交给计划任务/systemd 托管）
node phone-proxy-supervisor.mjs

# 2) 临时门
node temp-door.mjs --minutes 30     # 开 30 分钟
node temp-door.mjs --close          # 立即关

# 3) 机器人长连接（需先装 SDK 并写好配置）
pnpm add @wecom/aibot-node-sdk --registry=https://registry.npmmirror.com
node wecom-bot.mjs
```

## 配置（都放本机、都不入库）

| 文件 | 内容 | 模板 |
|---|---|---|
| `push.json` | 推送出口地址：`{ "webhook": "<YOUR_PUSH_WEBHOOK>" }`（也可用环境变量 `PUSH_WEBHOOK`） | `push.example.json` |
| `wecom-bot.json` | 机器人凭据：`{ "botId": "<YOUR_BOT_ID>", "secret": "<YOUR_BOT_SECRET>" }` | `../bot.example.json` |
| `bin/cloudflared.exe` | 隧道客户端（自行下载 + **验签**，不进仓库） | — |

## 上游自适应（重要）

传达室**不硬编码** DSH 端口：它每 5 秒读同目录的 `upstream.json`（由插件写入当前端口）。
所以 DSH 换端口、重启、升级都不用改这里。

## 说明：本目录是"发布副本"

- 公开仓库里放的就是这份**已脱敏**的副本；
- 在本机部署时，运行的是**上一级目录**（`../phone-proxy.mjs` 等）的版本，两者内容一致、只有脱敏差异；
- **改逻辑时请只改一处再同步**，避免两份漂移。若长期维护，建议把本目录作为唯一真源、本机改为引用它。

## 安全

- 门开着期间，**拿到网址的人不需要口令就能进**（这是"点通知即进"的代价）→ 只开短期、只发私密渠道、用完即关；
- 隧道客户端务必**验签**后再用（见 `../docs/GUIDE.md` 第 4 节）；
- 所有凭据文件已被 `../.gitignore` 排除，**提交前请跑一遍 `../docs/SECURITY.md` 第 5.3 节的自检**。
