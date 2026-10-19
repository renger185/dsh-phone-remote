# WeCom Deployment Tutorial (Phone Remote)

> Follow this and you end up with a complete loop:
> **send “开门” (open the door) in WeCom on your phone → the PC opens a timed door →
> the link comes straight back into your WeCom chat → tap it and work in a real browser.**
> Also included: “task finished” notifications and same-Wi-Fi direct access to the UI.
>
> Every credential in this document is a placeholder (`<YOUR_...>`), so copying it leaks nobody's secrets.
> For general principles and traps, see [ARCHITECTURE.md](ARCHITECTURE.md) / [PITFALLS.md](PITFALLS.md).
> Language: **English** · [中文](TUTORIAL-WECOM.md)

---

## 0. What you need

| Item | Notes |
|---|---|
| WeCom **admin** permission | Needed to create a group bot and an AI bot |
| An always-on PC | Running DSH (desktop app or `dsh web`) |
| Node.js 18+ | Verify with `node -v` |
| A phone | WeCom installed, in the same organization |
| ~40 minutes | Mostly waiting for downloads and configuration |

**Pick the right path first** (this tutorial uses ①):

| | ① AI bot (this tutorial) | ② Self-built app |
|---|---|---|
| Receiving messages | **Long connection** — the PC dials out | The platform **pushes to a public callback URL** |
| Stable public address required | **No** | **Yes** (a home broadband connection effectively cannot do this — do not go here) |
| Credentials to configure | `Bot ID` + `Secret` | `Token` + `EncodingAESKey` + `Secret` |

> How to tell them apart: if the configuration page shows **“receive-message URL / Token / EncodingAESKey”**,
> that is ② — walk away. If it shows **“Bot ID / Secret”** and offers a long-connection mode, that is ①.

---

## 1. Install the plugin

Load the `plugin/` directory with the DSH plugin manager (`install_bundle`, target = its absolute path).

Then confirm three things:

1. the plugin row is enabled;
2. **refresh the page** (the client module list is fixed at page load) — a “📱 Console” button appears at the bottom-left;
3. the plugin shows up under Settings → Plugins.

> If it installed but no panel appears: check whether `package.json` contains a `dsh.client` section;
> after adding it, **reinstall once** and refresh. (See `PITFALLS.md` §9.)

---

## 2. Configure the push sink: a WeCom **group bot**

### 2.1 Get the webhook URL

1. In WeCom, **create a group containing only yourself** (a private group);
2. group menu (top-right) → **Group Bots** → **Add bot** → create;
3. copy the generated **webhook URL**, shaped like:

```
https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=<YOUR_WECOM_WEBHOOK_KEY>
```

> ⚠️ This URL *is* a credential (it contains the key). **Never post it publicly and never commit it.**

### 2.2 Put it in the plugin config

Use `config.example.yml` as the reference, and put the real value into your local patch
(**that file is excluded by `.gitignore`**):

```yaml
pushWebhook: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=<YOUR_WECOM_WEBHOOK_KEY>'
```

### 2.3 Verify the push

Send one message by hand; HTTP 200 with `{"errcode":0,"errmsg":"ok"}` means it works:

```bash
curl -s -X POST -H "Content-Type: application/json" \
  --data '{"msgtype":"text","text":{"content":"[test] push channel is alive"}}' \
  'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=<YOUR_WECOM_WEBHOOK_KEY>'
```

---

## 3. Start the “front desk”: use the UI from a phone on the same Wi-Fi

```bash
node phone-proxy.mjs                     # foreground test run
curl -i http://<YOUR_LAN_IP>:51130/      # expect 302 (key auto-renewed) or 401
```

**It must be managed by the OS scheduler.** Otherwise it gets killed together with the host app whenever
that app restarts (see `PITFALLS.md` §4). On Windows, a scheduled task:

```powershell
$node   = "<absolute path to node.exe>"
$script = "<WORKSPACE_DIR>\phone-proxy-supervisor.mjs"
$action  = New-ScheduledTaskAction -Execute $node -Argument ('"' + $script + '"') -WorkingDirectory "<WORKSPACE_DIR>"
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew -Hidden
Register-ScheduledTask -TaskName "DshPhoneProxy" -Action $action -Trigger $trigger -Settings $settings -Force
Start-ScheduledTask -TaskName "DshPhoneProxy"
```

Verify the process lineage (the parent should be the Task Scheduler service, not your terminal):

```powershell
$p = Get-NetTCPConnection -State Listen -LocalPort 51130 | Select-Object -First 1
(Get-CimInstance Win32_Process -Filter "ProcessId=$($p.OwningProcess)").ParentProcessId | % {
  (Get-CimInstance Win32_Process -Filter "ProcessId=$_").Name }   # expect: svchost
```

Now your phone (same Wi-Fi) can open `http://<YOUR_LAN_IP>:51130/`.

---

## 4. While out: the timed door

### 4.1 Prepare the tunnel client (cloudflared)

Direct GitHub downloads are frequently reset in mainland China — **use a mirror, and always verify the signature**:

```powershell
curl.exe -L -o cloudflared.exe "https://<MIRROR_HOST>/https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
Get-AuthenticodeSignature .\cloudflared.exe | Select-Object Status, @{n='Signer';e={$_.SignerCertificate.Subject}}
# Criterion: Status = Valid AND Signer is "Cloudflare, Inc." — only then use it
Get-FileHash .\cloudflared.exe -Algorithm SHA256      # keep for the record
```

### 4.2 Open and close the door

```bash
node temp-door.mjs --minutes 30     # 30 minutes (typical when going out)
node temp-door.mjs --minutes 3      # 3 minutes (use once and burn)
node temp-door.mjs --close          # close immediately
```

Opening the door pushes a message with the link to your WeCom group; **it closes automatically and the link dies.**

> Security note: while the door is open, **anyone holding that URL gets in without a password**
> (that is the price of “tap the notification and you are in”). So: private groups only, short windows,
> close it when done. For stronger isolation, add a gate password (see `SECURITY.md`).

---

## 5. The core piece: WeCom **AI bot** over a long connection (summon from anywhere)

### 5.1 Create the AI bot in the WeCom admin console

1. WeCom **admin console** → find the “Bots / AI bots” entry (menu names differ slightly between
   versions; search the console for “bot” if needed);
2. create a bot and note its **Bot ID** and **Secret**;
3. make sure it runs in **long-connection** mode (no callback URL to fill in at all).

You end up with:

```
Bot ID : <YOUR_BOT_ID>
Secret : <YOUR_BOT_SECRET>
```

> To chat with it: add it to a private group, or open its own conversation.

### 5.2 Install the official SDK

```bash
mkdir bot && cd bot
# In mainland China use a mirror registry — much faster
pnpm add @wecom/aibot-node-sdk --registry=https://registry.npmmirror.com
# or: npm i @wecom/aibot-node-sdk --registry=https://registry.npmmirror.com
```

### 5.3 Write the bot (credentials live in a local file, never hard-coded)

**`bot/wecom-bot.json`** (**not committed** — already covered by `.gitignore`):

```json
{ "botId": "<YOUR_BOT_ID>", "secret": "<YOUR_BOT_SECRET>" }
```

**`bot/wecom-bot.mjs`** (minimal working version):

```js
import AiBot, { generateReqId } from '@wecom/aibot-node-sdk'
import fs from 'node:fs'
import { spawn } from 'node:child_process'

const cfg = JSON.parse(fs.readFileSync(new URL('./wecom-bot.json', import.meta.url), 'utf8'))
const client = new AiBot.WSClient({ botId: cfg.botId, secret: cfg.secret })

client.on('authenticated', () => console.log('✅ long connection authenticated, bot is online'))

client.on('message.text', async (frame) => {
  const text = frame?.body?.text?.content ?? ''
  const streamId = generateReqId('stream')
  if (text.includes('开门')) {
    await client.replyStream(frame, streamId, 'Got it, opening the door…', false)
    const link = await openDoor(30)                 // see below: start the door and parse its public URL
    await client.replyStream(frame, streamId,
      link ? `**Door open (30 min)**\n[Open it here](${link})` : 'Failed to open the door; check the PC logs.', true)
  } else {
    await client.replyStream(frame, streamId, `Received: ${text}`, true)
  }
})

// Start the timed door and get its public URL (reuses temp-door.mjs)
// ⚠️ Do NOT "grab the first URL" from the child's output: temp-door now builds the tunnel
//    first and then probes it from the public side, retrying with a different tunnel if the
//    probe fails — grabbing early hands the user a stale URL (see PITFALLS.md #15).
//    Correct approach: read the door-state.json that temp-door writes, and only accept the
//    door that was just opened.
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

> The `../temp-door.mjs` and `new URL('./wecom-bot.json', ...)` paths are relative — adjust them to your layout.

### 5.4 Put it under the OS scheduler

```powershell
$action  = New-ScheduledTaskAction -Execute "<absolute path to node.exe>" `
  -Argument ('"' + "<WORKSPACE_DIR>\bot\wecom-bot.mjs" + '"') -WorkingDirectory "<WORKSPACE_DIR>\bot"
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew -Hidden
Register-ScheduledTask -TaskName "DshWecomBot" -Action $action -Trigger $trigger -Settings $settings -Force
Start-ScheduledTask -TaskName "DshWecomBot"
```

Confirm in the log:

```
[....] bot starting, connecting to the WeCom long connection…
[....] ✅ long connection authenticated, bot is online (no public address involved)
```

### 5.5 Test

Find the bot in WeCom and send **“开门”**. Expected:

1. an immediate reply: “Got it, opening the door…”;
2. a few seconds later: “**Door open (30 min)**” plus a tappable link.

---

## 6. Optional: make the message body actually do work

Right now only “open the door” performs a real action; any other text is echoed back.
To make “send anything and it executes”, forward the text to a DSH session inside `message.text`
(for example by submitting a user message through the session-control interface) and reply with the result.
That is an upper-layer extension — implement it against whatever interface your DSH version exposes.

---

## 7. Acceptance checklist

**PC side (automatable)**

- [ ] Push: `curl` the WeCom webhook → `errcode:0`
- [ ] Front desk: `curl http://<YOUR_LAN_IP>:51130/` → `302/401`; follow the tokenized link → final `200`
- [ ] Proxy log shows `upgrade ok` (WebSocket works)
- [ ] Timed door: after opening, the public URL gives `302 → 200`; after the timer, `530`
- [ ] Bot: log shows “authenticated”; sending a message logs “received text”
- [ ] Keep-alive: kill the child → it recovers within seconds; a second launch yields to the first

**Phone side (human only)**

- [ ] On the same Wi-Fi, tap the notification link → the UI opens and you can dispatch work
- [ ] **Turn Wi-Fi off (mobile data only)** and tap the notification link → the UI opens
      (since v0.3.0 notifications always carry a public link; see `PITFALLS.md` #17)
- [ ] On mobile data, tap the timed-door link → the UI opens
- [ ] Send “开门” in WeCom → the link arrives in the chat → it opens
- [ ] A finished task → you get a notification (and its link opens outside your home network)
- [ ] **After rebooting the PC**: the bot is still online and “开门” still works

---

## 8. WeCom-specific troubleshooting

| Symptom | Root cause | Fix |
|---|---|---|
| The bot never receives messages sent in a group | Group bots are **send-only** | Switch to an **AI bot** long connection (§5) |
| Saving the callback URL fails with a verification error | That mode requires returning the **decrypted** `echostr` | Use the long connection; or see `PITFALLS.md` §2 |
| After a PC reboot, WeCom messages no longer arrive | You used callback mode and the quick tunnel changed domain | Switch to the long connection (**do not** buy a domain to patch this) |
| Sending a reply fails with `errcode 41004` | Missing `Secret` (only Token/AESKey configured) | Add the missing credential |
| The push never reaches the phone | Group bot removed / phone notifications disabled | Check the bot is still in the group; check system notification settings |
| The panel disappears after a PC reboot | The plugin's Host half did not come up | Check the plugin row is enabled and the scheduled task is running |

---

## 9. Sanitization checklist (WeCom-specific)

Before pushing to a public repository, make sure none of these **real values** is present:

| Item | Looks like | Replace with |
|---|---|---|
| Group-bot webhook | `.../webhook/send?key=<uuid>` | `<YOUR_WECOM_WEBHOOK_KEY>` |
| AI bot Bot ID | a platform-assigned string | `<YOUR_BOT_ID>` |
| AI bot Secret | a random string | `<YOUR_BOT_SECRET>` |
| Corp ID / app Secret (if you use a self-built app) | `ww...` / random string | `<YOUR_CORP_ID>` / `<YOUR_APP_SECRET>` |
| WeCom userid | often a name in pinyin | `<YOUR_USER_ID>` |
| LAN IP / workspace path | `192.168.x.x` / a personal path | `<YOUR_LAN_IP>` / `<WORKSPACE_DIR>` |

For self-check commands and more detail, see [SECURITY.md](SECURITY.md) §5
(**search for your own real values — every search must come back empty**).
