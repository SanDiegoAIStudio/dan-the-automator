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

Control routes (signal intake, `POST /trigger`, `POST /webhook/trigger`, job reads, job gates, kill-switch writes, heartbeat writes) answer 503 and change nothing until `DAN_CONTROL_TOKEN` is set, unless `DAN_LOCAL_SHOWCASE` is exactly `1`. In that showcase mode, a mutating route requires `Content-Type: application/json`. A request that sends an `Origin` header is rejected unless that origin is `http://localhost:<port>` or `http://127.0.0.1:<port>`.

Anthropic and GitHub keys stay off the default path.

## Environment

| Variable | Required | Notes |
|----------|----------|--------|
| `PORT` | No | Default `3456` |
| `DAN_HOST` | No | Default `127.0.0.1`. If this is not a loopback address and `DAN_CONTROL_TOKEN` is unset, the process exits with one line and does not listen. `DAN_LOCAL_SHOWCASE` does not override that refusal. |
| `DAN_DATA_DIR` | No | Default `./data` (kill-switch, jobs, heartbeats). An empty value is an error. The CLI and the server print the resolved directory on start. `dan ks gate` prints nothing. |
| `DAN_CONTROL_TOKEN` | Beyond a laptop demo | Set this for anything beyond a laptop demo. Unset, control routes return 503 and change nothing. When set, those routes need `Authorization: Bearer` plus the token. A missing or wrong bearer is 401. `POST /webhook/trigger` uses this rule. |
| `DAN_LOCAL_SHOWCASE` | No | Exactly `1` is for local demos only. It leaves control routes open when `DAN_CONTROL_TOKEN` is unset, and the server logs one warning at start. It does not write a kill-switch file. |
| `SENTRY_WEBHOOK_SECRET` | No* | HMAC-SHA256 on `sentry-hook-signature`. If unset, `POST /webhook/sentry` returns 503 and ingests nothing. |
| `DAN_ALLOW_UNSIGNED_WEBHOOKS` | No | Exactly `1` is for local demos only. It accepts unsigned Sentry posts when the secret is unset, and logs one warning at start. It is refused at start when `DAN_HOST` is not a loopback address. Any other value leaves the 503 in place. |
| `SLACK_WEBHOOK_URL` | No | Incoming webhook. Unset = silent skip |

\* Set `DAN_CONTROL_TOKEN` and `SENTRY_WEBHOOK_SECRET` before you expose this process past localhost. Leave `DAN_LOCAL_SHOWCASE` and `DAN_ALLOW_UNSIGNED_WEBHOOKS` unset there. Both `=1` flags are for local demos only.

`ANTHROPIC_API_KEY` and `GITHUB_TOKEN` stay off the happy path. Leave live keys out of a showcase `.env`.

## Run

```bash
bun dev                 # watch
bun start               # no watch
bun test
bun run typecheck
bun run src/cli.ts help
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
bun run src/cli.ts ks on "do not touch production this week"
curl -s localhost:3456/health   # status: held
bun run src/cli.ts ks off
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
data/kill-switch.json          # committed default: inactive
data/jobs.json                 # proposals, held jobs, and decisions
data/heartbeats/<name>.json    # gitignored pulses
data/kill-switch.log           # gitignored audit
```

A missing kill-switch file reads as armed, reason `state file missing`. `bun run src/cli.ts init` writes a clear file when none exists. It leaves an existing file in place and prints the current mode. A corrupt or unreadable kill-switch file stays in place; fix or remove it, then run `dan init`. The audit line is appended before the state file is replaced. If that append fails while arming, the switch still arms and the response carries a warning. If it fails while clearing, the switch stays armed and the error is returned. When an armed switch is past `expires_at`, the first read rewrites the file as clear once.

Jobs persist in `data/jobs.json`. A restart keeps pending proposals. Each change takes an exclusive lock beside the file, re-reads it, and writes it atomically. Memory changes only after that write succeeds. `dan ingest` and `dan approve` work in separate processes. Signals ingested while the switch is armed are held. Any process that loads the job store while the switch is clear moves those held jobs to the proposal step in ingest order, including a clear from another process, a restart, and an expiry. A repeated signal with the same source and ref returns the existing job while it is open (ingested, held, diagnosing, or proposed). After it is rejected, reported, or failed, the same signal queues a new job. A decided job stays decided. A corrupt jobs file is reported as `could_not` with its path and is left in place. A stored job whose signal no longer validates is kept and listed as `could_not` with a reason, and the other jobs still load. A heartbeat file is written with a temp file and then renamed. A heartbeat file that cannot be parsed, or an unreadable heartbeat file or folder, is reported as `could_not` and counts as stale. `/health` then reports degraded. `/heartbeats` and `dan health` still respond.

## Production notes

This is a showcase skeleton. The process listens on `127.0.0.1` unless `DAN_HOST` is set. A non-loopback `DAN_HOST` with `DAN_CONTROL_TOKEN` unset exits before it listens.

1. Set `DAN_CONTROL_TOKEN` and `SENTRY_WEBHOOK_SECRET`. Leave `DAN_LOCAL_SHOWCASE` and `DAN_ALLOW_UNSIGNED_WEBHOOKS` unset. Both `=1` flags are for local demos only.
2. Keep the kill-switch file on a writable volume
3. Keep `/trigger` and `/webhook/trigger` behind the control token
4. Keep private ops data out of the cutaway
