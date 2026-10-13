# Setup

Dan runs on Bun.

## Install

```bash
curl -fsSL https://bun.sh/install | bash
git clone https://github.com/SanDiegoAIStudio/dan-the-automator.git
cd dan-the-automator
bun install
cp .env.example .env
```

## Minimum local config

Set `DAN_CONTROL_TOKEN` for anything beyond a laptop demo. `DAN_LOCAL_SHOWCASE=1` and `DAN_ALLOW_UNSIGNED_WEBHOOKS=1` are for local demos only.

An empty `.env` with `PORT=3456` is enough to:

- serve the cutaway at `/`
- hit `/health`, `/os`, `/kill-switch`, `/heartbeats`, and `/status.json`
- skip Slack

Control routes (signal intake, `POST /trigger`, `POST /webhook/trigger`, job reads, job gates, kill-switch writes, heartbeat writes) answer 503 and change nothing until `DAN_CONTROL_TOKEN` is set, unless `DAN_LOCAL_SHOWCASE` is exactly `1`. An empty token counts as unset. In showcase mode, every control route, GET included, requires a Host header of `localhost:<port>` or `127.0.0.1:<port>`. A mutating route also requires `Content-Type: application/json`. A request that sends an `Origin` header is rejected unless that origin is `http://localhost:<port>` or `http://127.0.0.1:<port>`.

Anthropic and GitHub keys stay off the default path.

## Environment

| Variable | Required | Notes |
|----------|----------|--------|
| `PORT` | No | Default `3456` |
| `DAN_HOST` | No | Default `127.0.0.1`. If this is not a loopback address and `DAN_CONTROL_TOKEN` is unset, the process exits with one line and does not listen. `DAN_LOCAL_SHOWCASE` does not override that refusal. |
| `DAN_DATA_DIR` | No | Default `./data` (kill-switch file, its audit log, and heartbeats). Jobs stay in memory. An empty value is an error. The CLI and the server print the resolved directory on start. `dan ks gate` prints nothing. |
| `DAN_CONTROL_TOKEN` | Beyond a laptop demo | Set this for anything beyond a laptop demo. An empty value counts as unset. Unset, control routes return 503 and change nothing. When set, those routes need `Authorization: Bearer` plus the token. A missing or wrong bearer is 401. `POST /webhook/trigger` uses this rule. |
| `DAN_LOCAL_SHOWCASE` | No | Exactly `1` is for local demos only. It leaves control routes open when `DAN_CONTROL_TOKEN` is unset, and the server logs one warning at start. Every control route in that mode, GET included, requires a Host header of `localhost:<port>` or `127.0.0.1:<port>`. It does not write a kill-switch file. |
| `SENTRY_WEBHOOK_SECRET` | No* | HMAC-SHA256 on `sentry-hook-signature`. An empty value counts as unset. If unset, `POST /webhook/sentry` returns 503 and ingests nothing. |
| `DAN_ALLOW_UNSIGNED_WEBHOOKS` | No | Exactly `1` is for local demos only. It accepts unsigned Sentry posts when the secret is unset, and logs one warning at start. It is refused at start when `DAN_HOST` is not a loopback address. Any other value leaves the 503 in place. |
| `SLACK_WEBHOOK_URL` | No | Incoming webhook. Unset = silent skip |

\* Set `DAN_CONTROL_TOKEN` and `SENTRY_WEBHOOK_SECRET` before you expose this process past localhost. Leave `DAN_LOCAL_SHOWCASE` and `DAN_ALLOW_UNSIGNED_WEBHOOKS` unset there. Both `=1` flags are for local demos only.

`ANTHROPIC_API_KEY` and `GITHUB_TOKEN` stay off the happy path. Leave live keys out of a showcase `.env`.

## Run

```bash
bun run cli init        # once, writes a clear kill-switch file when none exists
bun dev                 # watch
bun start               # no watch
bun test
bun run typecheck
bun run cli help
```

Expected boot log:

```
[Dan] Intelligent OS control plane on :3456
[Dan] Data dir: /absolute/path/data
[Dan] Cutaway:        http://localhost:3456/
```

## Smoke

```bash
curl -s localhost:3456/health
curl -s localhost:3456/os
curl -s -X POST localhost:3456/signals \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $DAN_CONTROL_TOKEN" \
  -d '{"source":"operator","kind":"error","title":"null deref","file":"src/a.ts"}'
curl -s localhost:3456/jobs \
  -H "Authorization: Bearer $DAN_CONTROL_TOKEN"
```

Kill-switch:

```bash
bun run cli ks on "do not touch production this week"
curl -s localhost:3456/health   # status: held
bun run cli ks off
```

Sentry webhook:

```bash
# With SENTRY_WEBHOOK_SECRET unset, POST /webhook/sentry returns 503.
# DAN_ALLOW_UNSIGNED_WEBHOOKS=1 is for local demos only. It accepts unsigned posts and logs one warning at start.
# The process refuses to start with that flag when DAN_HOST is not a loopback address.
# Sign bodies the way tests/helpers.ts signPayload does when the secret is set.
```

## Data on disk

```
data/kill-switch.json          # written by `bun run cli init`, gitignored
data/heartbeats/<name>.json    # gitignored pulses
data/kill-switch.log           # gitignored audit
```

A missing, unreadable, or corrupt kill-switch file reads as armed. `bun run cli init` writes a clear file when none exists, and it refuses to overwrite an existing one. The state file is written with a temp file in the same folder, then rename. The audit line is appended after that write. If the append fails, it is logged, the response carries a warning, and the state stays as written. An armed switch past `expires_at` reads as clear, the file stays as it is, and status shows `expired`.

Jobs live in the memory of the one server process and are lost on restart. `dan ingest`, `dan approve`, `dan reject`, `dan jobs`, and `dan show` send HTTP to `127.0.0.1` and send `DAN_CONTROL_TOKEN` when it is set. `dan health` reads job counts from that server. If no server answers, they print one line telling you to start `bun dev` and exit 1. A wrong or missing control token, or a server with no token configured, prints one line and exits 1. Signals ingested while the switch is armed stay held. The same process releases them in ingest order when it sees the switch clear: on `ks off` through the server, and on the next ingest or job listing after an expiry. A repeated signal with the same source and ref returns the existing job while it is open (ingested, held, diagnosing, or proposed). After it is rejected, reported, or failed, the same signal queues a new job. A decided job stays decided. A heartbeat file is written with a temp file and then renamed. A heartbeat file that cannot be parsed, or an unreadable heartbeat file or folder, is reported as `could_not` and counts as stale. `/health` then reports degraded. `/heartbeats` and `dan health` still respond.

## Production notes

This is a small demo of the control plane. The process listens on `127.0.0.1` unless `DAN_HOST` is set. A non-loopback `DAN_HOST` with `DAN_CONTROL_TOKEN` unset exits before it listens. A non-loopback `DAN_HOST` with `DAN_ALLOW_UNSIGNED_WEBHOOKS=1` also exits before it listens.

1. Set `DAN_CONTROL_TOKEN` and `SENTRY_WEBHOOK_SECRET`. Leave `DAN_LOCAL_SHOWCASE` and `DAN_ALLOW_UNSIGNED_WEBHOOKS` unset. Both `=1` flags are for local demos only.
2. Keep the kill-switch file on a writable volume
3. Keep `/trigger` and `/webhook/trigger` behind the control token
4. Keep private ops data out of the cutaway
