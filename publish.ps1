<#
  publish.ps1 - build a copy that is safe to upload to a public repo.

  USAGE (Windows built-in PowerShell is enough, no PowerShell 7 needed):
    powershell -ExecutionPolicy Bypass -File .\publish.ps1 -Target <output-dir>
    # then: cd <output-dir> ; git init ; git add . ; git commit ; git push

  WHY THIS FILE IS PURE ASCII (do not add Chinese literals here):
    Windows PowerShell 5.1 reads a .ps1 WITHOUT BOM as the system ANSI code page
    (GBK on this machine). Any Chinese literal in the source then turns into
    mojibake and the whole script fails to parse - and it fails at RUNTIME,
    silently, the first time someone runs it. We hit this three times
    (source file, and the published copy other people would run).
    So: keep this file pure ASCII. Chinese strings that are genuinely needed
    (the rewrite table below) are built at runtime from char codes.

  EXCLUDED FILES (contain credentials, personal paths or binaries - never commit):
    cordis.patch.yml / wecom-bot.json / wecom-app.json / push.json / push_channels.json
    login-link.txt / upstream.json / door-state.json / logs/ / bin/ / node_modules/ / *.log
    plus any backup file (*.bak / *.bak_* / *_bak_*) - see the note in the copy loop.

  SANITIZATION GATE (added 2026-10-21):
    After packing, this script runs the sanitization self-check by itself.
    If the check fails, the exit code is non-zero -> the package must NOT be
    uploaded. Previously the check was only a sentence in README.md, i.e. it
    depended on the human remembering to run it.
#>
param(
  [string]$Source = "",
  [Parameter(Mandatory = $true)][string]$Target,
  [string]$PushChannels = ''
)

# Build a Chinese string from UTF-16 code points (keeps this file pure ASCII).
function U([int[]]$codes) {
  return -join ($codes | ForEach-Object { [char]$_ })
}
# workspace names / private nicknames that must never reach a public repo
$WS_TOUYAN = U @(0x6295,0x7814)                          # tou yan
$WS_ZONGWU = U @(0x603B,0x52A1)                          # zong wu
$WS_SHENGHUO = U @(0x751F,0x6D3B,0x4E8B,0x60C5)          # sheng huo shi qing
$WS_SHAOBING = U @(0x54E8,0x5175,0x7CFB,0x7EDF)          # shao bing xi tong
$WS_ZILIAO = U @(0x8D44,0x6599,0x5E93)                    # zi liao ku
$BOSS = U @(0x8001,0x677F)                                # lao ban
$NAME = U @(0x7433,0x5A18)                                # qiong niang
$PH_WORKSPACE = "<" + (U @(0x4F60,0x7684,0x5DE5,0x4F5C,0x533A)) + ">"
# ⚠ 两个盘符写法的占位符必须【不同】：改写后如果它们变成同一个值，
#   [ordered]@{...} 就会撞「重复的键」→ 副本脚本语法错（实测踩到）。
$PH_DATADIR   = "<" + (U @(0x4F60,0x7684,0x6570,0x636E,0x76EE,0x5F55)) + ">"
$PH_DATADIR2  = "<" + (U @(0x4F60,0x7684,0x6570,0x636E,0x76EE,0x5F55,0x4E8C)) + ">"
$PH_AUTHOR    = U @(0x4F5C,0x8005)                        # zuo zhe
$PH_ASSISTANT = U @(0x52A9,0x624B)                        # zhu shou
# 【10-21 boss定：称呼统一用 boss】原来「boss」被换成「作者」，
#   boss原话：「另外，你说的称呼问题统一用 boss 代替」
$PH_BOSS      = "boss"

$excludeFiles = @(
  'cordis.patch.yml', 'wecom-bot.json', 'wecom-app.json',
  'push.json', 'push_channels.json',
  'login-link.txt', 'upstream.json', 'door-state.json'
)
$excludeDirs = @('node_modules', 'logs', 'bin')

# NOTE: do NOT use $PSScriptRoot as the default value of $Source - under some
# invocation styles it resolves to an empty string, the source becomes the
# current directory, and the script recursively scans all of remote-gateway
# (7000+ files). Use $MyInvocation.MyCommand.Path inside the body instead.
if ([string]::IsNullOrWhiteSpace($Source)) {
  $selfDir = Split-Path -Parent $MyInvocation.MyCommand.Path
  $Source = $selfDir
}

if (-not (Test-Path $Source)) { throw "source dir not found: $Source" }

# ⚠ 2026-10-21 加：打包前**清空目标目录**（.git 除外）。
#   为什么：原来只 New-Item 不清空 → 上一轮包里的**旧文件会一直留在新包里**。
#   实测踩到：07:30 那轮打包的相对路径多了一层，产出
#   companion 下多套嵌套的 mjs、docs 下多套嵌套的 md、locale 下多套嵌套的 json
#   三套嵌套残留；下一轮打包时它们**不会被覆盖、也不会被删**，
#   最后连同 .bak 备份一起被拷进发布包 → 闸门判脏、退出码 1。
#   清空 = 发布包内容只取决于源目录，不会被历史残留污染。
#   ⚠ .git 必须保留（目标目录同时是 git 仓库，清掉就推不了了）。
if (Test-Path $Target) {
  Get-ChildItem $Target -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -ne '.git' } |
    ForEach-Object {
      Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
    }
}
New-Item -ItemType Directory -Path $Target -Force | Out-Null

# ---- rewrite rules for text files (only the COPY is changed; source untouched) ----
# order matters: specific first, generic later. Same table as dsh-skin's
# verify/make_publish.cjs REWRITES.
$textExt = @(".js", ".cjs", ".mjs", ".json", ".yml", ".yaml", ".md", ".txt", ".py", ".css", ".svg", ".html", ".xml", ".ps1")
$rewrites = [ordered]@{
  $BOSS        = $PH_BOSS
  $NAME        = $PH_ASSISTANT
  $WS_TOUYAN   = $PH_WORKSPACE
  $WS_ZONGWU   = $PH_WORKSPACE
  $WS_SHENGHUO = $PH_WORKSPACE
  $WS_SHAOBING = $PH_WORKSPACE
  $WS_ZILIAO   = $PH_WORKSPACE
  '<你的数据目录>'  = $PH_DATADIR
  '<你的数据目录二>'  = $PH_DATADIR2
}

$rewritten = 0
$copied = 0; $skipped = 0
Get-ChildItem $Source -Recurse -File | ForEach-Object {
  $rel = $_.FullName.Substring($Source.Length).TrimStart('\', '/')
  $parts = $rel -split '[\\/]'
  if ($parts | Where-Object { $excludeDirs -contains $_ }) { $skipped++; return }
  if ($excludeFiles -contains $_.Name) { $skipped++; return }
  if ($_.Extension -eq '.log') { $skipped++; return }
  # 2026-10-21: backup files never enter the package.
  #   A backup is the OLD version of a file; it often still carries the
  #   pre-change real paths / nicknames, and the rewrite table only sees the
  #   CURRENT content -> the backup would slip past the gate.
  #   Measured 10-21 01:42: publish.ps1.bak_20261021_0141 got packed and the
  #   sanitization gate immediately flagged it (exit 1) - the gate was right,
  #   the package was dirty.
  if ($_.Name -like '*.bak' -or $_.Name -like '*.bak_*' -or $_.Name -like '*_bak_*') { $skipped++; return }

  $dest = Join-Path $Target $rel
  New-Item -ItemType Directory -Path (Split-Path $dest) -Force | Out-Null
  # 2026-10-21 (owner rule): the uploaded DOCS must be sanitized too.
  #   Previously only credential FILES were dropped by name and the body text
  #   kept every private trace (internal nicknames, workspace names).
  #   Now: text files are rewritten while copying (source stays byte-identical).
  $ext = $_.Extension.ToLowerInvariant()
  if ($textExt -contains $ext) {
    $text = Get-Content $_.FullName -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
    if ($null -ne $text) {
      $changed = $false
      foreach ($key in $rewrites.Keys) {
        if ($text.Contains($key)) {
          # MUST use -replace, not .Replace(a,b): PowerShell picks the
          # Replace(char,char) overload and only swaps the first char.
          $text = $text -replace [regex]::Escape($key), $rewrites[$key]
          $changed = $true
        }
      }
      if ($changed) { $rewritten++ }
      # Write the copy WITH BOM: this script contains Chinese, and PS 5.1
      # parses a BOM-less .ps1 as ANSI -> mojibake -> syntax error.
      # Without the BOM the published copy could not even be run by anyone else.
      [System.IO.File]::WriteAllText($dest, $text, (New-Object System.Text.UTF8Encoding($true)))
    } else {
      Copy-Item $_.FullName $dest -Force
    }
  } else {
    Copy-Item $_.FullName $dest -Force
  }
  $copied++
}

# ---- the plugin package MUST ship a cordis.patch.yml (DSH expects that filename),
#      but the local one carries the real path/IP and cannot be uploaded.
#      Put a sanitized template in its place. ----
$template = Join-Path $Source 'config.example.yml'
if (Test-Path $template) {
  New-Item -ItemType Directory -Path $Target -Force | Out-Null
  Copy-Item $template (Join-Path $Target 'cordis.patch.yml') -Force
  Write-Host "used the sanitized template for cordis.patch.yml (edit it for your own path/IP)"
}

# ---- release .gitignore: exclude credentials and artifacts, but NOT cordis.patch.yml ----
$gitignore = @'
node_modules/
logs/
bin/
*.log
*.bak
*.bak_*
wecom-bot.json
wecom-app.json
push.json
push_channels.json
login-link.txt
upstream.json
door-state.json
'@
[System.IO.File]::WriteAllText((Join-Path $Target '.gitignore'), $gitignore, (New-Object System.Text.UTF8Encoding($true)))

Write-Host ""
Write-Host "OK - publish copy generated: $Target"
Write-Host "   copied $copied files, skipped $skipped sensitive/artifact files"
Write-Host "   rewrote $rewritten files (private nicknames / workspace names -> generic)"
Write-Host ""

# ======================================================================
# Sanitization self-check - MACHINE GATE (added 2026-10-21)
# ======================================================================
# Why a gate: the sanitization check used to be only one sentence in README.md
#   ("please run it again before uploading"), i.e. it relied on the human
#   remembering. The owner's 10-19 decision was "make it a command, not
#   something to remember" - the script existed, but the publish flow never
#   called it, so people still pushed without running it.
# Now: packing runs the check automatically; a non-zero exit means
#   "this package must NOT be uploaded".
$sanitizeScript = Join-Path (Split-Path -Parent $PSScriptRoot) 'tools\check-publish-sanitization.ps1'
if (-not (Test-Path $sanitizeScript)) {
  Write-Host ""
  Write-Host "FAIL - sanitization script not found: $sanitizeScript" -ForegroundColor Red
  Write-Host "   no gate = cannot prove the package is clean -> treated as FAILED (exit 2)." -ForegroundColor Red
  exit 2
}
Write-Host "running the sanitization self-check (a failure blocks the upload)..."
$checkArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $sanitizeScript, '-Target', $Target)
# The channel table (real wecom webhook) lives outside the plugin dir -> pass it in.
if (-not $PushChannels) {
  $PushChannels = '<你的数据目录>\' + $WS_TOUYAN + '\' +
    (U @(0x6838,0x5FC3,0x8D44,0x4EA7,0x6295,0x7814,0x6570,0x636E,0x5E93)) + '\' +
    (U @(0x6570,0x636E,0x53F0,0x8D26)) + '\push_channels.json'
}
if (Test-Path $PushChannels) { $checkArgs += @('-PushChannels', $PushChannels) }
& powershell @checkArgs
$checkCode = $LASTEXITCODE
Write-Host ""
if ($checkCode -ne 0) {
  Write-Host "FAIL - sanitization check did not pass (exit $checkCode). DO NOT UPLOAD." -ForegroundColor Red
  Write-Host "   fix the files it named, then pack again." -ForegroundColor Red
  exit 1
}
Write-Host "OK - sanitization check passed (exit 0). This package is safe to upload." -ForegroundColor Green
Write-Host ""
Write-Host "then:"
Write-Host "   cd '$Target'"
Write-Host "   git init ; git add . ; git commit -m 'feat: dsh phone-remote plugin'"
