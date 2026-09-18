# Architecture

Dan is a **control-plane skeleton** for the San Diego AI Studio Intelligent OS. Sentry autofix is one intake lane. The product is the riverbed: properties, layers, kill-switch, heartbeats, human-gated actions.

## Why this shape

The previous repo was a Sentry → Claude → GitHub dream with stubs that never wired end-to-end. The operating system that actually runs the studio is larger: eight layers, five properties, a programmatic kill-switch, and a flywheel. This codebase models that — and stays honest about what is local and in-memory.

```
signal (Sentry | operator | heartbeat | revenue | content | ops)
   │
   ▼
Zod + optional HMAC / control token
   │
   ▼
kill-switch read
   ├── missing file → fail-open
   ├── corrupt file → fail-closed (blocks work)
   └── active=true  → job HELD
   │
   ▼
diagnose (deterministic, local)
   │
   ▼
propose (always requiresHumanGate: true)
   │
   ▼
human approve | reject
   │
   ▼
report (optional Slack) — no silent production writes
```

## Layers (THE-SYSTEM, public-safe)

| Layer | Name | In this repo |
|-------|------|----------------|
| 0 | Substrate | Process + `data/` on disk |
| 1 | Compute serving | Local diagnose only. No silent model calls. |
| 2 | Memory | Out of scope here. The cutaway shows the idea. |
| 3 | Knowledge ingestion | `/signals`, Sentry adapter, CLI ingest |
| 4 | Agent fleet | Named roster on `GET /os` — not a runtime of 35 processes |
| 5 | Quality gates | Human gate on every proposal |
| 6 | Observability | `/health`, heartbeats, job list |
| 7 | Revenue protection | `data/kill-switch.json` + CLI `ks` |
| 8 | Compound | Roadmap |

## Key files

| File | Job |
|------|-----|
| `public/index.html` | Living cutaway (hero) |
| `public/status.json` | Illustrative statuses |
| `src/index.ts` | Hono app: health, OS card, intake, jobs, static |
| `src/cli.ts` | `dan` CLI — same modules as HTTP |
| `src/types.ts` | Zod schemas. No `any`. |
| `src/kill-switch.ts` | Atomic write, fail-open / fail-closed |
| `src/heartbeats.ts` | Pulse files, stale = age > 2× cadence |
| `src/diagnose.ts` | Local rules + propose-only autofix prompt |
| `src/pipeline.ts` | ingest → diagnose → propose → gate |
| `src/queue.ts` | In-memory `ActionQueue` |
| `src/intake/sentry.ts` | HMAC adapter → `Signal` |
| `src/hmac.ts` | SHA-256 + timing-safe compare |
| `src/notify/slack.ts` | Optional incoming webhook |
| `src/properties.ts` | Five properties + eight layers |
| `src/fleet.ts` | Public agent names |

## Job state

```
pending → diagnosing → proposed → approved → reported
                 ↘ held (kill-switch)
                 ↘ failed
proposed → rejected
```

`FAILED` / `HELD` can be reached instead of `PROPOSED`. There is no `deployed` fairy tale on this path.

## Kill-switch contract

Copied from THE-SYSTEM Layer 7, minus private paths:

```json
{
  "schema_version": 1,
  "active": false,
  "reason": "",
  "since": null,
  "set_by": "human"
}
```

- Missing file → fail-open (first boot). Logged by mode on `/health`.
- Parse failure → fail-closed, reason `corruption`, append `kill-switch-corruption.log`.
- Writes are temp-file + rename.
- `active=true` requires a non-empty reason.
- Every ingest reads the file before diagnosing.

## Sentry is an adapter

`POST /webhook/sentry` still verifies `sentry-hook-signature` (HMAC-SHA256, timing-safe). `created` / `triggered` become `kind: "error"` signals. If a filename is present, diagnose recommends `autofix-candidate`. Nothing calls Claude or opens a PR unless a future live lane is explicitly added behind the kill-switch.

## Security posture

| Door | Auth |
|------|------|
| Sentry | HMAC when `SENTRY_WEBHOOK_SECRET` is set; skipped (with warning) when unset |
| `/signals`, `/kill-switch` POST, `/heartbeats` POST, approve/reject | Bearer `DAN_CONTROL_TOKEN` when set; open when unset (local showcase) |
| `/trigger` | None — local only |
| Slack | Outbound webhook; skipped if unset |
| Cutaway | Public, sanitized. No live secrets, no home paths, no private IPs |

Do not run a public bind with the control token unset.

## What was deleted

`src/agent/fixer.ts`, `src/github/pr.ts`, and the Redis/Bull/Postgres fiction. They were stubs that implied a production healer. The diagnose module keeps a **propose-only** prompt builder so the autofix lane stays typed without pretending a model is in the loop.
