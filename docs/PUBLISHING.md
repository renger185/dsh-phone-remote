# 发布到 GitHub / Gitee（维护者手册）

> 面向：要把本插件分享出去的人。
> 背景：在中国大陆直连 GitHub 时，**网页慢（十几秒）、`raw.githubusercontent.com` 常被墙**，
> 但 **API 很快**、**SSH 走 443 端口可用**。本手册的方法就是"绕开慢网页，走 CLI + SSH/443"。

---

## 0. 三个概念先说清（为什么这么做）

GitHub 要三样东西，缺一不可：

| 要素 | 是什么 | 怎么给 |
|---|---|---|
| **身份** | 证明"推代码的人是你" | **SSH 密钥**（公钥挂到 GitHub，私钥留在本机） |
| **仓库** | 云端放代码的抽屉 | 用 `gh` 命令行建，或网页建 |
| **内容** | 你要推的文件夹 | `git init/add/commit/push` |

> 为什么不推荐网页建仓：`github.com` 网页在国内常要 10 秒以上才开，
> 而 `api.github.com` 实测 1~2 秒。**能走命令行的就别开网页。**

---

## 1. 准备

```powershell
git --version      # 期望有版本号
gh --version       # GitHub 官方 CLI
```

如果没有 `gh`：`winget install GitHub.cli`（国内可能较慢，可换镜像或官网下载）。

**生成 SSH 密钥**（本机只做一次）：

```powershell
ssh-keygen -t ed25519 -C "publish" -f "$env:USERPROFILE\.ssh\id_ed25519" -N '""'
```

- 生成两个文件：`id_ed25519`（**私钥，绝不外传**）、`id_ed25519.pub`（公钥，可以公开）。
- `-N '""'` 表示不设口令，便于自动化；若你在意安全，去掉它并自行输入口令。

**让 GitHub 走 443**（很多网络下 22 端口不通）：

```text
# %USERPROFILE%\.ssh\config
Host github.com
    HostName ssh.github.com
    Port 443
    User git
    IdentityFile ~/.ssh/id_ed25519
    ServerAliveInterval 30
```

验证通道（出现 `Permission denied (publickey)` 是**好事**：说明通道通、只差授权）：

```powershell
ssh -T git@github.com
```

---

## 2. 授权（一次）

```powershell
gh auth login
# 选：GitHub.com → HTTPS → Login with a web browser
# 屏幕给一个 8 位码，浏览器打开 https://github.com/login/device 输入
```

验证：`gh auth status` 应显示已登录的账号。

> 不想开网页的替代：在 GitHub 建 Personal Access Token（勾 `repo`），
> 然后 `gh auth login --with-token < token.txt`。

## 3. 把公钥挂到账号上

```powershell
gh ssh-key add "$env:USERPROFILE\.ssh\id_ed25519.pub" --title "my-publish-key"
```

再验一次，这次应看到**问候语**（`Hi <你的用户名>! You've successfully authenticated...`）：

```powershell
ssh -T git@github.com
```

> 网页替代：github.com/settings/keys → New SSH key → 粘贴 `.pub` 文件内容。

## 4. 建仓库

```powershell
# 只建仓库（内容稍后手动推，适合学习）
gh repo create <仓库名> --public --description "DSH plugin: phone remote control"
```

> 想让 `gh` 直接建库并推送（一步到位）：
> `gh repo create <仓库名> --public --source=<本地目录> --push`

## 5. 推送内容

```powershell
cd <本地目录>
git init
git add .
git commit -m "feat: dsh phone-remote plugin"
git branch -M main
git remote add origin git@github.com:<你的用户名>/<仓库名>.git
git push -u origin main
```

**推送前必做**：确认没有把真实配置推上去（见 `SECURITY.md` 第 5 节）。
推荐先用一键打包脚本生成干净副本，再对副本执行上面几步。

## 6. 加简介与标签（让别人搜得到）

```powershell
# 简介
gh repo edit <你的用户名>/<仓库名> --description "手机远程操控 DSH：浏览器原生页面 + 限时门 + 机器人长连接"

# 打标签（GitHub Topics；dsh-plugin 是社区话题页用的标签）
gh api --method PUT /repos/<你的用户名>/<仓库名>/topics -f 'names[]=dsh-plugin' -f 'names[]=deepseek-harness'
```

## 7. 验证

```powershell
gh repo view <你的用户名>/<仓库名> --web      # 打开网页看
git ls-remote origin                          # 能看到远程分支即推送成功
```

别人在 https://github.com/topics/dsh-plugin 就能看到你的仓库。

---

## 8. 国内网络常见故障

| 症状 | 原因 | 处置 |
|---|---|---|
| `ssh -T git@github.com` 卡住/超时 | 22 端口被干扰 | 用本文第 1 节：改走 `ssh.github.com:443` |
| `Permission denied (publickey)` 一直存在 | 公钥没挂上 / 用了错的密钥文件 | `gh ssh-key list` 看有没有；核对 `IdentityFile` |
| `push` 到一半断 | HTTPS 链路不稳 | 改用 SSH（本文），或重试；大仓库可分批推 |
| 网页打不开/极慢 | 网页资源被拖慢 | 用 `gh` 完成操作；必须开网页时多刷一次 |
| README 里图片不显示 | 用了 `raw.githubusercontent.com` 直链 | 改用**仓库内相对路径**（被墙域名不可依赖） |
| DNS 解析看着不对 | 可能污染 | 用 DoH 对照（如 `https://dns.alidns.com/resolve?name=github.com&type=A`）；一致就别改 hosts |

## 9. 备选：国内镜像（Gitee）

GitHub 之外，把同一份内容推到 Gitee 能让国内读者**秒开**：

```powershell
git remote add gitee git@gitee.com:<你的用户名>/<仓库名>.git
git push gitee main
```

两个远端可以长期并存；`git push origin`（GitHub）与 `git push gitee` 各自独立。

---

### English summary

Publishing this plugin from mainland China: **the GitHub web UI is slow and
`raw.githubusercontent.com` is often blocked, but `api.github.com` is fast and
`ssh.github.com:443` works.** So: generate an SSH key, point `github.com` at
`ssh.github.com:443` in `~/.ssh/config`, authenticate with `gh auth login`,
add the key with `gh ssh-key add`, create the repo and topics with `gh`/`gh api`,
then push over SSH. Use relative asset paths in README (never `raw.githubusercontent.com`).
A Gitee mirror is the pragmatic complement for domestic readers.
