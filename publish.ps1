<#
  publish.ps1 — 生成"可直接上传公开仓库"的副本（自动剔除所有真实配置与运行产物）。

  用法（Windows 自带 PowerShell 即可，无需 PowerShell 7）：
    powershell -ExecutionPolicy Bypass -File .\publish.ps1 -Target ..\..\dsh-phone-remote-publish
    # 生成到指定目录，然后 git init / git add / git commit / push 即可

  剔除清单（这些文件含凭据、个人路径或二进制，绝不入库）：
    cordis.patch.yml / wecom-bot.json / wecom-app.json / push.json / push_channels.json
    login-link.txt / upstream.json / door-state.json / logs/ / bin/ / node_modules/ / *.log
#>
param(
  [string]$Source = $PSScriptRoot,
  [Parameter(Mandatory = $true)][string]$Target
)

$excludeFiles = @(
  'cordis.patch.yml', 'wecom-bot.json', 'wecom-app.json',
  'push.json', 'push_channels.json',
  'login-link.txt', 'upstream.json', 'door-state.json'
)
$excludeDirs = @('node_modules', 'logs', 'bin')

if (-not (Test-Path $Source)) { throw "源目录不存在: $Source" }
New-Item -ItemType Directory -Path $Target -Force | Out-Null

$copied = 0; $skipped = 0
Get-ChildItem $Source -Recurse -File | ForEach-Object {
  $rel = $_.FullName.Substring($Source.Length).TrimStart('\', '/')
  $parts = $rel -split '[\\/]'
  if ($parts | Where-Object { $excludeDirs -contains $_ }) { $skipped++; return }
  if ($excludeFiles -contains $_.Name) { $skipped++; return }
  if ($_.Extension -eq '.log') { $skipped++; return }

  $dest = Join-Path $Target $rel
  New-Item -ItemType Directory -Path (Split-Path $dest) -Force | Out-Null
  Copy-Item $_.FullName $dest -Force
  $copied++
}

# —— 关键补齐：插件包必须带一个 cordis.patch.yml（DSH 认这个文件名），
#     但本机的那个含真实路径/IP，不能上传。这里用脱敏模板顶替它。——————
$template = Join-Path $Source 'config.example.yml'
if (Test-Path $template) {
  New-Item -ItemType Directory -Path $Target -Force | Out-Null
  Copy-Item $template (Join-Path $Target 'cordis.patch.yml') -Force
  Write-Host "已用脱敏模板顶替 cordis.patch.yml（使用者按自己的路径/IP 修改）"
}

# —— 发布版 .gitignore：只排除凭据与产物，不排除 cordis.patch.yml（发布的是占位符版）——
$gitignore = @'
node_modules/
logs/
bin/
*.log
wecom-bot.json
wecom-app.json
push.json
push_channels.json
login-link.txt
upstream.json
door-state.json
'@
[System.IO.File]::WriteAllText((Join-Path $Target '.gitignore'), $gitignore, (New-Object System.Text.UTF8Encoding($false)))

Write-Host ""
Write-Host "✅ 已生成可上传副本：$Target"
Write-Host "   复制 $copied 个文件，剔除 $skipped 个敏感/产物文件（凭据、日志、二进制、本机配置）"
Write-Host ""
Write-Host "上传前请务必再跑一遍脱敏自检（docs/SECURITY.md 第 5.3 节）："
Write-Host "   用你自己的真实值（Bot ID / Secret / Webhook key / 内网 IP / 工作目录）逐个反查，全部应为无命中。"
Write-Host ""
Write-Host "然后："
Write-Host "   cd '$Target'"
Write-Host "   git init ; git add . ; git commit -m 'feat: dsh phone-remote plugin'"
