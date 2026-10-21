# Phone Remote — drive your DSH from a phone

> Open the local DeepSeek Harness (DSH) Web UI **in a real mobile browser from anywhere**,
> get notified when a task finishes, and **summon a remote door by sending one message** —
> no domain purchase, no router changes, no cloud server.

A minimal, working setup built from **one DSH plugin** plus **three small companion services**.
Language: **English** · [中文](README.md)

---

## What it solves

DSH's Web UI listens on `127.0.0.1` only, so a phone cannot reach it. This project adds four capabilities:

| # | Capability | How |
|---|---|---|
| 1 | Open the DSH UI from a phone on the same Wi‑Fi | Local reverse proxy ("front desk") + automatic login-key renewal |
| 2 | Use the **native browser UI** while out on mobile data | **Temporary timed door** (auto-closes, link expires) |
| 3 | Get notified when a task finishes or fails | Any **webhook push channel** (WeCom group bot, Feishu, DingTalk, ntfy…) |
| 4 | Summon from anywhere by sending one chat message | **Bot long connection** (Bot ID + Secret, outbound only) |

## Layout

```
plugin/                  # the DSH Cordis plugin (Host half + Client half) — this directory
├─ index.js              #   Host: mint the mobile login link, write upstream.json, push on completion/error
├─ client.js             #   Client: the 📱 Console panel (workspace partitions + busy/idle + dispatch)
├─ cordis.patch.yml      #   plugin row config (replace with config.example.yml before publishing)
├─ config.example.yml    #   sanitized config template
├─ bot.example.json      #   sanitized bot-credential template
├─ docs/                 #   PITFALLS / GUIDE / ARCHITECTURE / SECURITY / TUTORIAL-WECOM
├─ companion/            #   the three companion services (sanitized publish copies)
└─ .gitignore            #   excludes real credentials, logs and binaries

   companion/phone-proxy.mjs            # front desk: 51130 → 127.0.0.1:<DSH port> (rewrites Host/Origin)
   companion/temp-door.mjs              # timed door: cloudflared quick tunnel, auto-closes
   companion/wecom-bot.mjs              # bot long connection (example: WeCom AI bot)
```

> The companions are optional. The plugin alone covers capabilities **1 and 3**;
> `temp-door.mjs` adds **2**; `companion/` adds **4**.

---

## Quick start (shortest path)

1. **Install the plugin**: load this `plugin/` directory with the DSH plugin manager (`install_bundle`, target = absolute path of this directory).
2. **Configure two things** (see `config.example.yml`):
   - `pushWebhook` — any endpoint that accepts `POST` JSON (WeCom / Feishu / DingTalk / ntfy …);
   - `linkFile` / `mobileBaseUrl` — where to write the login link, and the address prefix your phone can reach.
3. **Start the front desk** (same Wi‑Fi): `node companion/phone-proxy-supervisor.mjs`, ideally under a
   system scheduler (see `docs/GUIDE.md`) — otherwise it dies whenever the host app restarts.
4. **(Optional) Start the bot long connection**: fill `botId`/`secret`, run `node companion/wecom-bot.mjs`.
   Now sending “开门” (open the door) from your phone summons a remote door.

Step-by-step instructions, per-platform mapping and a verification checklist:
**[docs/GUIDE.md](docs/GUIDE.md)** · WeCom-specific walkthrough: **[docs/TUTORIAL-WECOM.md](docs/TUTORIAL-WECOM.md)**

---

## Documentation

| Document | Contents |
|---|---|
| **[docs/TUTORIAL-WECOM.en.md](docs/TUTORIAL-WECOM.en.md)** | WeCom deployment tutorial (AI bot long connection + group-bot push + scheduler + troubleshooting); Chinese original: [TUTORIAL-WECOM.md](docs/TUTORIAL-WECOM.md) |
| [docs/GUIDE.md](docs/GUIDE.md) | General guide: prerequisites, six steps, platform mapping, verification checklist, troubleshooting |
| [docs/PITFALLS.md](docs/PITFALLS.md) | **Pitfalls we actually hit** (symptom → root cause → fix) — read this before designing your own |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Architecture and data flow, platform-agnostic abstraction, component responsibilities |
| [docs/SECURITY.md](docs/SECURITY.md) | Threat surface, trade-offs, credential handling, **pre-publish sanitization checklist** |

## Platform independence

The design deliberately avoids binding to one chat platform. Two interfaces are enough:

- **Outbound (notifications)** — a **webhook URL** that accepts `POST` JSON.
  WeCom group bot, Feishu custom bot, DingTalk bot, ntfy, Slack all qualify.
- **Inbound (receiving messages)** — a **Bot ID + Secret** with a **long connection**
  (the client dials out to receive messages). WeCom AI bot, Feishu self-built app and
  QQ bots all provide this.

> The crucial trade-off: **inbound must use a long connection**, never "the platform pushes to a
> public callback URL". The latter requires a **stable** public HTTPS address, which a home
> broadband connection effectively cannot provide (see `docs/PITFALLS.md`, items 1 and 3).

## Before publishing this to a public repo

Ship **code and placeholders only**. Do not commit:

- `cordis.patch.yml` (holds real workspace paths, LAN IP, push channel) → use `config.example.yml`;
- any real `*.json` credentials (bot `botId`/`secret`, push channel table) → use `bot.example.json` / `push.example.json`;
- logs, downloaded binaries, and runtime state (already covered by `.gitignore`).

Then run the self-check commands in `docs/SECURITY.md` §5.3 — **every search must come back empty**.

## License / provenance

The reference implementation targets WeCom (official SDK `@wecom/aibot-node-sdk`).
Contributions adding other platforms via the interfaces described in `docs/ARCHITECTURE.md` are welcome.
