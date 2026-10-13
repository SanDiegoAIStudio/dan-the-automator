# Architecture

Dan is the public control plane for the San Diego AI Studio Intelligent OS. A signal comes in, the process checks it, and a person approves or rejects the proposal. Sentry is one intake adapter.

## Flow

```
signal (Sentry | operator | heartbeat | revenue | content | ops)
   |
   v
Zod + HMAC or control token
   |
   v
kill-switch read
   |-- missing, unreadable, or corrupt file -> armed (fail-closed)
   |-- active and not yet expired -> job held
   |-- active and past expires_at -> reads as clear, file left as written
   v
diagnose (local rules)
   |
   v
propose (requiresHumanGate: true)
   |
   v
human approve | reject
   |
   v
report (optional Slack)
```

## Layers

| Layer | Name | In this repo |
|-------|------|----------------|
| 0 | Substrate | One Bun process and `data/` on disk |
| 1 | Compute serving | Local diagnose. Model calls stay outside this process. |
| 2 | Memory | Out of scope here. The cutaway shows the idea. |
| 3 | Knowledge ingestion | `/signals`, Sentry adapter, CLI ingest |
| 4 | Agent fleet | Named roster on `GET /os`: a list of 34 processes that runs none of them |
| 5 | Quality gates | Human gate on every proposal |
| 6 | Observability | `/health`, heartbeats, job list |
| 7 | Revenue protection | `data/kill-switch.json` and CLI `ks` |
| 8 | Compound | Roadmap |

## Key files

| File | Job |
|------|-----|
| `public/index.html` | Living cutaway |
| `public/status.json` | Illustrative statuses |
| `src/index.ts` | Hono app: health, OS card, intake, jobs, static |
| `src/cli.ts` | `dan` CLI. `ingest`, `approve`, and `reject` call the server over HTTP on `127.0.0.1` |
| `src/types.ts` | Zod schemas |
| `src/config.ts` | Host, port, token, showcase, and startup checks |
| `src/kill-switch.ts` | One JSON file, atomic write, audit after the write |
| `src/heartbeats.ts` | Pulse files, stale = age > 2x cadence |
| `src/diagnose.ts` | Local rules and a propose-only autofix prompt |
| `src/pipeline.ts` | ingest, diagnose, propose, gate |
| `src/queue.ts` | In-memory jobs for this process |
| `src/intake/sentry.ts` | HMAC adapter to `Signal` |
| `src/hmac.ts` | SHA-256 and timing-safe compare |
| `src/notify/slack.ts` | Optional incoming webhook |
| `src/properties.ts` | Five properties and eight layers |
| `src/fleet.ts` | Public agent names |

## Jobs

One server process holds the jobs in memory. A restart drops them.

```
pending -> diagnosing -> proposed -> approved -> reported
                    \ held (kill-switch)
                    \ failed
proposed -> rejected
```

`HELD` and `FAILED` can be reached in place of `PROPOSED`. A repeated signal with the same source and ref returns the open job (pending, held, diagnosing, or proposed). After it is rejected, reported, or failed, the same signal queues a new job. A decided job stays decided. Title is capped at 200 characters and body at 8,000.

Signals ingested while the switch is armed stay held. The same process releases them in ingest order when it sees the switch clear: on `ks off` through the server, and on the next ingest or job listing after an expiry.

`dan ingest`, `dan approve`, and `dan reject` send HTTP to `127.0.0.1` and send `DAN_CONTROL_TOKEN` when it is set. If no server answers, they print one line telling you to start `bun dev` and exit 1. `dan jobs` and `dan show` print the jobs in the process that runs the command.

## Kill switch

```json
{
  "schema_version": 1,
  "active": false,
  "reason": "",
  "since": null,
  "set_by": "human"
}
```

- A missing, unreadable, or corrupt file reads as armed, with a reason. Only `dan init` writes a clear file, and it refuses to overwrite an existing one.
- An armed state past `expires_at` reads as clear. The file is left as it is. Status shows `expired`.
- A write uses a temp file in the same folder, then rename. The audit line is appended after that write. A failed append is logged and reported as a warning. The state stays as written.
- `active=true` requires a non-empty reason.
- Every ingest reads the file before diagnosing.

## Sentry

`POST /webhook/sentry` verifies `sentry-hook-signature` (HMAC-SHA256, timing-safe) when `SENTRY_WEBHOOK_SECRET` is set. An empty secret counts as unset. If the secret is unset, the route returns 503 and ingests nothing, unless `DAN_ALLOW_UNSIGNED_WEBHOOKS` is exactly `1`, in which case it accepts the post and logs one warning. A non-loopback `DAN_HOST` with that flag is refused at start. `created` and `triggered` become `kind: "error"` signals. If a filename is present, diagnose recommends `autofix-candidate`.

## Security

| Door | Auth |
|------|------|
| Sentry | HMAC when `SENTRY_WEBHOOK_SECRET` is set. HTTP 503 when it is unset, unless `DAN_ALLOW_UNSIGNED_WEBHOOKS` is `1` |
| Control routes | Bearer `DAN_CONTROL_TOKEN` when set. HTTP 503 when it is unset, unless `DAN_LOCAL_SHOWCASE` is exactly `1`. An empty token counts as unset. |
| Showcase | Every control route, GET included, requires Host `localhost:<port>` or `127.0.0.1:<port>`. A mutating route also requires `Content-Type: application/json` and a localhost Origin when Origin is sent. |
| Slack | Outbound webhook. Skipped if unset. |
| Cutaway | Public. Illustrative statuses. |

The server binds `127.0.0.1` by default. A non-loopback `DAN_HOST` with the control token unset exits before it listens.
