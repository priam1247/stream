# sessions

## What it does

| Command | Effect |
|---|---|
| `.sessions` / `.sessions status` | every linked number with its live state |
| `.sessions link <number>` | asks the gateway for a pairing code |

## How a number is linked

1. `.sessions link 265991234567`
2. the code arrives in the chat
3. WhatsApp → Linked devices → Link a device → Link with phone number instead
4. creds land in `sessions/linked/<number>/creds.json` (never in Git)

## External service

WhatsApp via Baileys. A dead number does not affect the others: each session has
its own socket and its own reconnect schedule.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| 🟠 closed forever | reconnect backoff exhausted / cookies rejected | delete `sessions/linked/<number>` and re-link |
| ⛔ logged_out | WhatsApp unlinked this device | re-link; the old creds cannot be reused |
| `MAX_LINKED_ACCOUNTS reached` | env limit | raise `MAX_LINKED_ACCOUNTS` |

## Fix flow

`node commands/sessions/check.js` → `.reload sessions`.
