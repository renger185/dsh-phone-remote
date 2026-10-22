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

# ---- SELF CHECK: this file MUST stay pure ASCII (added 2026-10-21) ----
# Why this gate exists: the BOM problem bit us THREE times. A .ps1 with
# Chinese text and NO BOM is read by Windows PowerShell 5.1 as the system
# ANSI code page (GBK here) -> the Chinese turns into mojibake -> the whole
# script fails to parse. Adding a BOM "fixes" it, but the BOM is lost again
# the next time ANY tool rewrites the file (an editor, another agent, a
# formatter) -> so the fix never sticks.
#
# The real fix is to keep the file pure ASCII, so the BOM does not matter.
# This gate is what makes that stick: if somebody adds a Chinese literal
# or a Chinese comment later, the pack fails loudly HERE (exit 3) instead of
# failing mysteriously the next time somebody runs the script.
#
# If you really need Chinese in this file, build it at runtime from char
# codes (see function U above) - that is the only supported way.
$__selfBytes = [System.IO.File]::ReadAllBytes($MyInvocation.MyCommand.Path)
$__nonAscii = 0
$__start = 0
# Skip a UTF-8 BOM if present (3 bytes EF BB BF) - the BOM itself is not
# "content"; it is the marker that tells PS 5.1 to read the file as UTF-8.
if ($__selfBytes.Length -ge 3 -and $__selfBytes[0] -eq 0xEF -and $__selfBytes[1] -eq 0xBB -and $__selfBytes[2] -eq 0xBF) {
  $__start = 3
}
for ($__i = $__start; $__i -lt $__selfBytes.Length; $__i++) {
  if ($__selfBytes[$__i] -gt 127) { $__nonAscii++ }
}
if ($__nonAscii -gt 0) {
  Write-Host ""
  Write-Host "FAIL - publish.ps1 contains $__nonAscii non-ASCII byte(s)." -ForegroundColor Red
  Write-Host "   This file MUST stay pure ASCII (PS 5.1 reads a BOM-less .ps1 as ANSI -> mojibake -> syntax error)." -ForegroundColor Red
  Write-Host "   Fix: use English comments, and build needed Chinese at runtime via U @(0x....)." -ForegroundColor Red
  Write-Host "   (Do NOT just add a BOM - the next edit drops it again.)" -ForegroundColor Red
  exit 3
}

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
# NOTE: the two drive-letter spellings MUST map to DIFFERENT placeholders.
#   If they map to the same value, the rewritten text gives [ordered]@{...}
#   two identical keys -> the published copy is a syntax error (measured).
$PH_DATADIR   = "<" + (U @(0x4F60,0x7684,0x6570,0x636E,0x76EE,0x5F55)) + ">"
$PH_DATADIR2  = "<" + (U @(0x4F60,0x7684,0x6570,0x636E,0x76EE,0x5F55,0x4E8C)) + ">"
$PH_AUTHOR    = U @(0x4F5C,0x8005)                        # zuo zhe
$PH_ASSISTANT = U @(0x52A9,0x624B)                        # zhu shou
# 2026-10-21 owner rule: the honorific is unified as "boss".
$PH_BOSS      = "boss"

$excludeFiles = @(
  'cordis.patch.yml', 'wecom-bot.json', 'wecom-app.json',
  'push.json', 'push_channels.json',
  'login-link.txt', 'upstream.json', 'door-state.json',
  # 2026-10-22 owner rule: the repo address now lives in a local note
  # (REPO_ADDRESS.md). It contains local workspace paths -> must not be
  # published. ASCII name on purpose: this file must stay pure ASCII
  # (see the note at the top of this script).
  'REPO_ADDRESS.md'
)
$excludeDirs = @('node_modules', 'logs', 'bin')

# NOTE: do NOT use $PSScriptRoot as the default value of $Source - under some
# invocation styles it resolves to an empty string, the source becomes the
# current directory, and the script recursively scans the whole workspace
# (7000+ files). Use $MyInvocation.MyCommand.Path inside the body instead.
if ([string]::IsNullOrWhiteSpace($Source)) {
  $selfDir = Split-Path -Parent $MyInvocation.MyCommand.Path
  $Source = $selfDir
}

if (-not (Test-Path $Source)) { throw "source dir not found: $Source" }

# 2026-10-21: clean the target directory before packing (.git excepted).
#   Why: the old code only did New-Item, so files left over from a PREVIOUS
#   pack stayed in the new package forever. Measured 10-21 07:30: one run
#   produced nested folders (companion under companion, docs under docs,
#   locale under locale); the next run neither overwrote nor removed them,
#   and they went into the release package together with a .bak backup ->
#   the sanitization gate flagged the package (exit 1).
#   Cleaning makes the package content depend on the source dir only.
#   .git MUST be kept (the target dir is also the git repo).
#   media/ MUST be kept too: it holds the demo video, which lives in the
#   repo and is NOT produced by the packing step. Cleaning it away would
#   delete a committed file (measured 10-21 11:44 - it showed up as
#   "D media/phone-remote-demo.mp4" in git status).
if (Test-Path $Target) {
  Get-ChildItem $Target -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -ne '.git' -and $_.Name -ne 'media' } |
    ForEach-Object {
      Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
    }
}
New-Item -ItemType Directory -Path $Target -Force | Out-Null

# ---- rewrite rules for text files (only the COPY is changed; source untouched) ----
# order matters: specific first, generic later. Same table as dsh-skin's
# verify/make_publish.cjs REWRITES.
#
# NOTE: the two drive-prefix keys MUST be built at runtime, not written literally.
#   Reason (a real leak, measured 10-21): the copy step rewrites TEXT. If the
#   literal drive prefix appears in this file, the copy step replaces it with
#   its own VALUE -> in the published copy the key becomes the placeholder and
#   the value is the same string -> key == value -> the rewrite is a no-op.
#   Consequence: someone who takes the published package and re-packs it gets
#   **no sanitization at all** - real paths would sail straight into the new
#   package. Building the key at runtime keeps the literal out of the file,
#   so the published copy keeps working keys.
#   NOTE: never write the placeholder itself in a comment either - the copy
#   step would rewrite that comment too, putting Chinese into the copy.
$SEP = [char]0x5C                                        # backslash
$DRIVE_E  = 'E:' + $SEP + 'deepseek'
$DRIVE_E2 = 'E:' + '/' + 'deepseek'
$textExt = @(".js", ".cjs", ".mjs", ".json", ".yml", ".yaml", ".md", ".txt", ".py", ".css", ".svg", ".html", ".xml", ".ps1")
$rewrites = [ordered]@{
  $BOSS        = $PH_BOSS
  $NAME        = $PH_ASSISTANT
  $WS_TOUYAN   = $PH_WORKSPACE
  $WS_ZONGWU   = $PH_WORKSPACE
  $WS_SHENGHUO = $PH_WORKSPACE
  $WS_SHAOBING = $PH_WORKSPACE
  $WS_ZILIAO   = $PH_WORKSPACE
  $DRIVE_E     = $PH_DATADIR
  $DRIVE_E2    = $PH_DATADIR2
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
      # BOM policy: ONLY .ps1 gets a BOM.
      #   Why: Windows PowerShell 5.1 reads a BOM-less .ps1 as the system ANSI
      #   code page (GBK here) -> mojibake -> syntax error -> the published
      #   copy could not even be run. That is a real, measured failure.
      #   Why not the other text files: a BOM in .md/.json/.js/.mjs is noise -
      #   it shows up as a "\ufeff" in every diff and can break strict JSON
      #   parsers. Those formats are read as UTF-8 by everything modern.
      $enc = if ($ext -eq '.ps1') { New-Object System.Text.UTF8Encoding($true) } else { New-Object System.Text.UTF8Encoding($false) }
      [System.IO.File]::WriteAllText($dest, $text, $enc)
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
[System.IO.File]::WriteAllText((Join-Path $Target '.gitignore'), $gitignore, (New-Object System.Text.UTF8Encoding($false)))

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
  # Use the runtime-built drive prefix (see $DRIVE_E above) - a literal drive
  # prefix written here would be rewritten into its own value in the
  # published copy, which silently breaks the default path there.
  $PushChannels = $DRIVE_E + $SEP + $WS_TOUYAN + $SEP +
    (U @(0x6838,0x5FC3,0x8D44,0x4EA7,0x6295,0x7814,0x6570,0x636E,0x5E93)) + $SEP +
    (U @(0x6570,0x636E,0x53F0,0x8D26)) + $SEP + 'push_channels.json'
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
