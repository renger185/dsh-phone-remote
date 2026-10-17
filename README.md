# Phone Remote · 手机远程操控 DSH 界面

> 让安卓/iPhone 手机在外面也能用**浏览器原生页面**打开本机的 DeepSeek Harness（DSH），
> 收「任务跑完」提醒，并在手机上给电脑发一句话就能**召唤**远程入口。

一套由插件 + 三个配套小服务组成的最小可用方案。**不需要买域名、不需要改路由器、不租服务器。**

语言：**中文** · [English](README.en.md)

---

## 它解决什么问题

DSH 的 Web 界面默认只监听 `127.0.0.1`，手机碰不到。本方案做四件事：

| # | 能力 | 走什么 |
|---|---|---|
| 1 | 同 WiFi 用手机浏览器直接开 DSH | 本机反向代理（传达室）+ 自动续登录钥匙 |
| 2 | 出门用流量也想用浏览器原生页面 | **临时限时门**（到点自动关，链接作废） |
| 3 | 任务跑完/出错主动提醒到手机 | 任意 **Webhook 推送通道**（企微群机器人等） |
| 4 | 手机发一句话就能召唤（在外面也能开门） | **机器人长连接**（Bot ID + Secret，主动连出去） |

## 目录结构

```
plugin/            # DSH 的 Cordis 插件（Host 半 + Client 半），本目录
├─ index.js        #   Host 半：生成手机入口链接、写 upstream、任务完成/出错推送
├─ client.js       #   Client 半：「📱 指挥台」窄屏面板（工作区分区 + 忙闲 + 派活）
├─ cordis.patch.yml#   插件行配置（上传前请替换为 config.example.yml 的占位符写法）
├─ config.example.yml  # 脱敏配置模板
├─ bot.example.json    # 机器人凭据模板（脱敏）
├─ docs/           # 文档：踩坑 / 引导 / 架构 / 安全
└─ .gitignore      # 排除真实凭据、日志、二进制

../phone-proxy.mjs        # 传达室：51130 → 127.0.0.1:<DSH端口>（改写 Host/Origin）
../temp-door.mjs          # 临时限时门：cloudflared 快速隧道，到点自动关
../bot/wecom-bot.mjs      # 机器人长连接（示例实现：企业微信智能机器人）
```

> 三个配套服务各自独立、可单独使用。**只用插件也能跑通第 1、3 条**；
> 第 2 条要 `temp-door.mjs`，第 4 条要 `bot/`。

---

## 快速开始（最短路径）

1. **装插件**：把 `plugin/` 目录用 DSH 的插件管理器装载（`install_bundle`，目标指向本目录）。
2. **配两项**（见 `config.example.yml`）：
   - `pushWebhook`：任意接受 `POST` JSON 的推送地址（企微群机器人 / 飞书自定义机器人 / 钉钉 / ntfy…）；
   - `linkFile` / `mobileBaseUrl`：入口链接落盘位置、手机可达的地址前缀。
3. **起传达室**（同 WiFi 直接用）：`node phone-proxy.mjs`，建议用系统计划任务托管（见 `docs/GUIDE.md`）。
4. **（可选）起机器人长连接**：填 `botId`/`secret` 后 `node bot/wecom-bot.mjs`，手机发「开门」即召唤。

细节步骤、分平台适配、验证清单见 **[docs/GUIDE.md](docs/GUIDE.md)**。

---

## 文档索引

| 文档 | 内容 |
|---|---|
| **[docs/TUTORIAL-WECOM.md](docs/TUTORIAL-WECOM.md)** | **企业微信部署教程**：照着做就能跑通（含智能机器人长连接 + 群机器人推送 + 计划任务托管 + 排障表）；英文版 [TUTORIAL-WECOM.en.md](docs/TUTORIAL-WECOM.en.md) |
| [docs/GUIDE.md](docs/GUIDE.md) | 通用引导：从零到跑通、平台适配表、验证清单、排障 |
| [docs/PITFALLS.md](docs/PITFALLS.md) | **踩坑总结**：我们实际踩过的每一个坑（现象 → 根因 → 对策） |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 架构与数据流、平台无关抽象（出口 Webhook / 入口 Bot） |
| [docs/SECURITY.md](docs/SECURITY.md) | 安全须知、凭据管理、**上传公开仓库前的脱敏清单** |

## 打包分享清单（要带走哪些文件）

仓库里**只放**：

```
plugin/
├─ index.js  client.js  package.json  icon.svg
├─ locale/{en,zh}.json
├─ config.example.yml      # 配置模板（占位符）
├─ bot.example.json        # 机器人凭据模板（占位符）
├─ README.md  docs/*.md  .gitignore
└─ companion/               # ← 上传前从上一级目录移入并脱敏（见下）
   ├─ phone-proxy.mjs  phone-proxy-supervisor.mjs
   ├─ temp-door.mjs
   └─ wecom-bot.mjs
```

**上传前必须处理的三件事**：

1. **不要提交** `cordis.patch.yml`（含真实工作路径 / 内网 IP / 推送频道）→ 用 `config.example.yml` 代替；
2. **不要提交** 任何 `*.json` 真实配置（机器人 `botId/secret`、推送通道表）→ 用 `bot.example.json` 代替；
3. `companion/` 里的三个配套脚本**已经是脱敏副本**（推送出口改读 `push.json` 或环境变量 `PUSH_WEBHOOK`；机器人脚本的相对路径已按同目录改好），直接带上即可。

> **更省事的做法**：跑一键打包脚本，它自动剔除全部敏感文件与产物：
> ```powershell
> pwsh -File .\publish.ps1 -Target ..\..\dsh-phone-remote-publish
> ```
> 生成目录即为**可直接 `git push`** 的仓库内容。
> 提交前请逐条跑 `docs/SECURITY.md` 第 5.3 节的自检命令，**全部应为"无匹配"**。

## 平台无关性

本方案刻意不绑定某个 IM 平台，只要满足下面两条就能适配：

- **出口（发通知）**：给一个 **Webhook 协议地址**，能 `POST` 一段 JSON。
  企微群机器人、飞书自定义机器人、钉钉机器人、ntfy、Slack…均可。
- **入口（收消息）**：给一个 **Bot ID + Secret**，且该平台支持**长连接**（客户端主动连出去收消息）。
  企业微信「智能机器人」、飞书自建应用、QQ 机器人均属此类。

> 关键取舍：**收消息一定要走长连接，不要走"平台把消息推到一个公网回调地址"**。
> 后者要求一个**固定不变**的公网 HTTPS 地址——家庭宽带几乎做不到（详见 `docs/PITFALLS.md` 第 1、3 条）。

## 许可与出处

示例实现以企业微信为基准（官方 SDK `@wecom/aibot-node-sdk`）。
欢迎按 `docs/ARCHITECTURE.md` 的适配接口补其他平台。
