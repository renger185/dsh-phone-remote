# 安全须知与公开前脱敏清单

## 一、先认清暴露面

本方案有两个"对外开口"和一个"凭证面"：

| # | 开口 | 默认可见范围 | 谁能进 |
|---|---|---|---|
| 1 | 传达室 `51130` | 局域网 | 能连到你家/公司网的人（凭登录票据） |
| 2 | 临时门（公网 HTTPS） | **公网** | **门开着期间，拿到该网址的人** |
| 3 | 机器人长连接 | 无入站开口 | 无（电脑主动连出去） |

> 关键认识：**第 2 条是唯一的公网暴露面**，而且只在"开门期间"存在。

## 二、最需要记住的一条权衡：门开着 = 有网址即可进

为了让"点通知直接进界面、不输账号"，传达室对**没有登录票据的访客会自动注入一次性钥匙**。
好处是体验；代价是**任何拿到该网址的人都能进**（不额外要口令）。

对策（按需要叠加）：

1. **只开短期**：`--minutes 3` / `30`，到点自动关、链接作废；
2. **只发私密渠道**：链接发到只有自己的 IM 会话/群，别转发、别截图；
3. **用完立即关**：`node temp-door.mjs --close`；
4. **要更强隔离**：在传达室上加一道**门卫口令**——首次访问须带 `?k=<口令>`，
   通过后下发 HttpOnly cookie，之后免输；口令随门一起作废。

反面教材：把临时门地址贴到公开群、或用它当"长期入口"。**不要这么做。**

### 2.1 注意：v0.3.0 起"公网开口"会被自动打开

为了让"任务完成通知里的链接在外面点得开"，插件在**发通知前**如果发现没有还够用的临时门，
会**自动开一扇 30 分钟的门**（见 `PITFALLS.md` 第 17 条）。

这意味着：**公网开口的出现时机不再只由你手动决定**——每完成一轮任务就可能短暂开一次。

想收紧，按需要调（都在插件配置里）：

| 想要的效果 | 怎么调 |
|---|---|
| 每次只开很短 | `doorMinutes: 3` |
| 尽量复用同一扇门、少开新的 | 调大 `doorMinRemainingMs`（默认 10 分钟） |
| 干脆不自动开 | 把 `doorScript` 指向不存在的位置 → 通知将**不带链接**（附一句说明），不会推死链 |

> 无论怎么调，第 2 条那个权衡不变：**门开着期间，拿到网址的人不需要口令就能进。**

## 三、凭据管理

| 凭据 | 存在哪 | 说明 |
|---|---|---|
| 推送 Webhook 地址 | 本机配置文件（或本机推送通道表） | **地址本身即凭据**（含 key） |
| 机器人 `Bot ID` / `Secret` | `bot/*.json`（本机） | 与平台账号绑定，泄漏可被冒充发消息 |
| DSH 登录票据 | 浏览器 cookie（30 天） | 想提前吊销：删凭据记录并重启宿主 |
| 临时门地址 | `door-state.json`（本机） | 只在门开着期间有效 |

原则：
- **凭据只落本机文件**，且一律写进 `.gitignore`；
- **不要写进任何记忆/知识库文档**；
- 日志里可能带链接与用户名，**日志目录也要排除**。

## 四、止损手段（出事时怎么办）

| 想达到 | 动作 |
|---|---|
| 立刻关掉公网入口 | `node temp-door.mjs --close`（或等它到点） |
| 停掉局域网入口 | 停计划任务 + 结束监听 51130 的进程 |
| 停掉机器人 | 停计划任务 + 结束机器人进程；必要时到平台后台**重置 Secret** |
| 吊销所有登录票据 | 删除宿主凭据记录并重启（本方案靠宿主自带的登录机制） |
| 换掉被泄漏的推送地址 | 在 IM 平台**重建机器人** → 新 Webhook，替换本机配置 |

## 五、上传公开仓库前的脱敏清单 ✅

> 目标：仓库里**只有代码与占位符**，没有任何真实凭据、地址、路径、人名。

### 5.1 必须替换成占位符的内容

| 类型 | 示例形态 | 替换为 |
|---|---|---|
| 机器人 Bot ID | 平台分配的一串随机标识 | `<YOUR_BOT_ID>` |
| 机器人 Secret | 43 位随机串 | `<YOUR_BOT_SECRET>` |
| 推送 Webhook 地址 | `https://…/webhook/send?key=<uuid>` | `<YOUR_PUSH_WEBHOOK>` |
| 推送频道/话题名 | 自定义频道名 | `<YOUR_TOPIC>` |
| 局域网 IP | `192.168.x.x` / `10.x.x.x` | `<YOUR_LAN_IP>` |
| 用户标识 | IM 里的 userid（如姓名拼音） | `<YOUR_USER_ID>` |
| 本机绝对路径 | 含个人目录名的工作路径 | `<WORKSPACE_DIR>` |

### 5.2 必须替换成模板的文件

| 真实文件（含敏感值，**不提交**） | 用哪个模板替代 |
|---|---|
| `cordis.patch.yml`（含真实路径/IP/通道） | `config.example.yml` |
| `bot/*.json`（含 Bot ID/Secret） | `bot.example.json` |
| 推送通道表（含 webhook key） | 在 `config.example.yml` 里说明如何填 |

### 5.3 提交前自检（逐条替换成你本机的真实值去搜，全部应为"无匹配"）

> 关键是**拿真实值去反查**，而不是靠肉眼看。下面每条都把 `<...>` 换成本机实际值再跑。

```bash
# 1) 逐个搜你本机的真实凭据
grep -rn "<YOUR_BOT_ID>"      . --exclude-dir=node_modules --exclude-dir=logs
grep -rn "<YOUR_BOT_SECRET>"  . --exclude-dir=node_modules --exclude-dir=logs
grep -rn "<YOUR_PUSH_WEBHOOK 里的 key 片段>" . --exclude-dir=node_modules --exclude-dir=logs
grep -rn "<YOUR_TOPIC>"       . --exclude-dir=node_modules --exclude-dir=logs

# 2) 搜内网地址与个人路径
grep -rnE "<你的内网网段，如 192\.168\.|10\.[0-9]+\.[0-9]+\.[0-9]+>" . --exclude-dir=node_modules --exclude-dir=logs
grep -rnE "C:\\\\Users|/Users/|<你的工作目录名>" . --exclude-dir=node_modules --exclude-dir=logs

# 3) 敏感文件本身不应被追踪
git status --porcelain | grep -E "\.json$|\.yml$|\.log$|\.exe$"
```

> 提示：第 3 条若列出 `cordis.patch.yml` / `*.json` 真实配置，说明漏进了暂存区——
> 把它们加入 `.gitignore` 后用 `git rm --cached <file>` 移出（**改历史不等于吊销凭据**，
> 真泄了要先去平台侧重置）。

### 5.4 建议的 `.gitignore`（本目录已提供）

```
node_modules/
logs/
bin/
*.log
# 本机真实配置（含凭据），只提交 *.example.*
wecom-bot.json
wecom-app.json
push_channels.json
cordis.patch.yml
login-link.txt
upstream.json
door-state.json
```

### 5.5 提交前最后确认

- [ ] 全文搜索过 Bot ID / Secret / Webhook key，**零命中**；
- [ ] 示例配置里全是 `<...>` 占位符，且注释说明去哪拿真值；
- [ ] 文档里没有真实域名、真实隧道地址、真实 userid、真实路径；
- [ ] 二进制（`cloudflared.exe` 等）未入库（在 `.gitignore` 里）；
- [ ] 日志目录未入库；
- [ ] 若曾提交过凭据：**先在平台侧重置/重建**，再清理历史（改历史不等于吊销）。
