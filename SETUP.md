# Setup

Dan runs on Bun. Not npm. Not yarn. Not pnpm.

## Install

```bash
curl -fsSL https://bun.sh/install | bash
git clone https://github.com/SanDiegoAIStudio/dan-the-automator.git
cd dan-the-automator
bun install
cp .env.example .env
```

## Minimum local config

An empty `.env` with `PORT=3456` is enough to:

- serve the cutaway at `/`
- hit `/health` and `/os`
- ingest signals
- arm the kill-switch
- skip Slack

You do **not** need Anthropic or GitHub keys. Those lanes are not on the default path.

## Environment

| Variable | Required | Notes |
|----------|----------|--------|
| `PORT` | No | Default `3456` |
| `DAN_DATA_DIR` | No | Default `./data` (kill-switch + heartbeats) |
| `DAN_CONTROL_TOKEN` | No* | If set, mutating control routes need `Authorization: Bearer …` |
| `SENTRY_WEBHOOK_SECRET` | No* | If unset, Sentry HMAC is skipped (console warning) |
| `SLACK_WEBHOOK_URL` | No | Incoming webhook. Unset = silent skip |

\* Set both secrets before you expose this process past localhost.

There is no `ANTHROPIC_API_KEY` / `GITHUB_TOKEN` on the happy path. Do not paste live keys into a showcase `.env` “just in case.”

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
[Dan] Cutaway:        http://localhost:3456/
```

## Smoke

```bash
curl -s localhost:3456/health
curl -s localhost:3456/os
curl -s -X POST localhost:3456/signals \
  -H 'Content-Type: application/json' \
  -d '{"source":"operator","kind":"error","title":"null deref","file":"src/a.ts"}'
curl -s localhost:3456/jobs
```

Kill-switch:

```bash
bun run src/cli.ts ks on "do not touch production this week"
curl -s localhost:3456/health   # status: held
bun run src/cli.ts ks off
```

Sentry HMAC (only if you set a secret):

```bash
# see tests/helpers.ts signPayload — or unset SENTRY_WEBHOOK_SECRET for local unsigned posts
```

## Data on disk

```
data/kill-switch.json          # committed default: inactive
data/heartbeats/<name>.json    # gitignored pulses
data/kill-switch.log           # gitignored audit
```

Jobs are not on disk. Restart clears the queue.

## Production notes

This is a showcase skeleton. If you bind it publicly:

1. Set `DAN_CONTROL_TOKEN` and `SENTRY_WEBHOOK_SECRET`
2. Keep the kill-switch file on a writable volume
3. Do not treat `/trigger` as an internet door
4. Do not point the cutaway at private ops data
