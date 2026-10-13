# Dan the Automator

Dan the Automator is a small Bun and Hono control plane that takes a signal, diagnoses it with local rules, and proposes an action a person must approve.

Set `DAN_CONTROL_TOKEN` for anything beyond a laptop demo. `DAN_LOCAL_SHOWCASE=1` and `DAN_ALLOW_UNSIGNED_WEBHOOKS=1` are for local demos only. With the token unset, and the showcase flag not exactly `1`, control routes answer 503 and change nothing. A set token requires a Bearer token. A missing or wrong bearer is 401. `POST /webhook/trigger` uses that same rule. In showcase mode, a mutating route requires `Content-Type: application/json`. A request that sends an `Origin` header is rejected unless that origin is `http://localhost:<port>` or `http://127.0.0.1:<port>`. `DAN_ALLOW_UNSIGNED_WEBHOOKS=1` is refused at start when `DAN_HOST` is not a loopback address. On a loopback bind its warning is logged once at start.

## Run it in two minutes

```bash
bun install
bun test
bun run src/cli.ts init
bun dev
```

`bun run src/cli.ts init` writes `data/kill-switch.json` when that file is missing, with the switch clear. When the file is already present, init leaves it in place and prints `had_no_work` plus the current mode. A missing state file is armed (`fail-closed`, reason `state file missing`), so a fresh disk stays armed until init. A showcase start does not write that file.

`bun install` checks packages and exits 0. `bun test` prints one line per test and finishes with a pass count, `0 fail`, and an expect count. `bun dev` listens on `127.0.0.1` port 3456 (`PORT` overrides the port, `DAN_HOST` overrides the address). If `DAN_HOST` is not a loopback address and `DAN_CONTROL_TOKEN` is unset, the process exits with one line and does not listen. `DAN_LOCAL_SHOWCASE=1` does not override that refusal. An empty `DAN_DATA_DIR` is an error. The CLI and the server print the resolved data directory on start. `dan ks gate` prints nothing. `dan ks status` prints the directory as well:

```
[Dan] Intelligent OS control plane on :3456
[Dan] Data dir: /absolute/path/data
[Dan] Cutaway:        http://localhost:3456/
[Dan] Health:         http://localhost:3456/health
[Dan] OS card:        http://localhost:3456/os
[Dan] Sentry intake:  POST http://localhost:3456/webhook/sentry
[Dan] Signal intake:  POST http://localhost:3456/signals
```

Open http://localhost:3456/ for the cutaway. Health:

```bash
curl -s localhost:3456/health
```

```json
{
  "status": "ok",
  "service": "dan-the-automator",
  "version": "0.2.0",
  "brand": "San Diego AI Studio",
  "uptime": 0.038576709,
  "killSwitch": {
    "active": false,
    "reason": "",
    "mode": "clear"
  },
  "heartbeats": {
    "total": 0,
    "stale": 0
  },
  "queue": {},
  "note": "Control-plane skeleton. Statuses on the cutaway are an illustrative snapshot."
}
```

`uptime` is seconds since the process started. `mode` is `clear` when `data/kill-switch.json` is present and inactive. A missing file is armed: mode `fail-closed`, reason `state file missing`. `dan ks gate` then exits 2 and the message says to run `dan init`. When the file is corrupt or unreadable, the message names the path and says to fix or remove it, then run `dan init`.

Arm the kill switch:

```bash
bun run src/cli.ts ks on "do not touch production this week"
```

```json
{
  "schema_version": 1,
  "active": true,
  "reason": "do not touch production this week",
  "since": "2026-10-13T03:14:11.841Z",
  "set_by": "human",
  "blocksWork": true,
  "mode": "armed"
}
```

`since` is the UTC time the switch was armed. Clear it with `bun run src/cli.ts ks off`. While it is armed, `curl -s localhost:3456/health` reports `"status": "held"`.

## What is real and what is illustrative

The control plane, kill switch, heartbeats, HMAC intake, and tests are real and run.

The cutaway page's statuses are an illustrative snapshot.

The autofix lane is human-gated and writes nothing to production by itself.

The Sentry webhook checks `sentry-hook-signature` when `SENTRY_WEBHOOK_SECRET` is set. With that variable unset it returns 503 and ingests nothing, unless `DAN_ALLOW_UNSIGNED_WEBHOOKS` is exactly `1`. That flag is refused at start on a non-loopback bind. On a loopback bind the warning is logged once at start.

## Limits

Anthropic calls, GitHub pull requests, and edits in other repos are outside this process. Slack is skipped when `SLACK_WEBHOOK_URL` is unset. Job ids are sent in a code span. Jobs are stored in `data/jobs.json` and stay there across restarts. Each change takes an exclusive lock, re-reads the file, writes it atomically, and updates memory only after that write succeeds. `dan ingest` and `dan approve` work in separate processes. A repeated signal with the same source and ref returns the existing job while it is open (ingested, held, diagnosing, or proposed). After it is rejected, reported, or failed, the same signal queues a new job. A corrupt jobs file is reported as `could_not` with its path and is left in place. A stored job whose signal no longer validates is kept and listed as `could_not` with a reason, and the other jobs still load. Signals ingested while the switch is armed stay held. Any process that loads the job store while the switch is clear moves those held jobs to the proposal step in ingest order. That includes a clear from another process, a restart, and an expiry. When an armed switch is past `expires_at`, the first read rewrites the file as clear. An unreadable heartbeat file or folder counts as stale, and `/health` reports degraded.

## Layout

| File | Role |
|------|------|
| `src/index.ts` | Hono app and routes |
| `src/cli.ts` | `dan` command |
| `src/kill-switch.ts` | Kill switch file, atomic write |
| `src/heartbeats.ts` | Pulse registry |
| `src/intake/sentry.ts` | Sentry webhook (HMAC) |
| `src/pipeline.ts` | Ingest, diagnose, human gate |
| `public/index.html` | Cutaway page |
| `public/status.json` | Illustrative statuses |
| `tests/` | Test suite |

## License

MIT

Built at San Diego AI Studio. sandiegoaistudio.com
