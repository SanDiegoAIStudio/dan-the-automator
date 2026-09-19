# Dan the Automator

Public Intelligent OS control plane for San Diego AI Studio / Luc Face. Signal in → diagnose → propose → human gate. The living cutaway is the hero. Sentry is one intake adapter.

## Quick Start

```bash
bun install
bun dev            # :3456 — cutaway at /
bun test
bun run typecheck
bun run src/cli.ts help
```

## Architecture

```
Signal (Sentry | operator | heartbeat | revenue | content | ops)
  → Zod (+ HMAC or control token)
  → kill-switch (missing=fail-open, corrupt=fail-closed)
  → diagnose (local rules)
  → propose (always human-gated)
  → approve | reject
  → optional Slack
```

Five properties, revenue first when they conflict: revenue-protective → truth-anchored → self-correcting → compounding → compute-optimal.

Eight layers: substrate, compute, memory, ingestion, fleet, quality gates, observability, revenue protection, compound. This repo implements a skeleton of 3, 5, 6, 7 plus a public map of the rest.

## Key Files

| File | Purpose |
|------|---------|
| `public/index.html` | Sanitized living cutaway |
| `public/status.json` | Illustrative statuses — not live telemetry |
| `src/index.ts` | Hono app |
| `src/cli.ts` | `dan` CLI |
| `src/kill-switch.ts` | Layer 7 file + atomic write |
| `src/heartbeats.ts` | Pulse registry |
| `src/pipeline.ts` | ingest → diagnose → gate |
| `src/intake/sentry.ts` | HMAC Sentry adapter |
| `src/diagnose.ts` | Local diagnosis; propose-only autofix prompt |
| `src/types.ts` | Zod schemas |
| `tests/` | bun:test — control plane, HMAC, cutaway scrub |

## Endpoints

`GET /` cutaway · `GET /health` · `GET /os` · `GET|POST /kill-switch` · `GET|POST /heartbeats` · `POST /signals` · `POST /webhook/sentry` · `POST /trigger` · `GET /jobs` · `GET /jobs/:id` · `POST /jobs/:id/approve` · `POST /jobs/:id/reject` · `GET /status.json`

## Environment

`PORT` `DAN_DATA_DIR` `DAN_CONTROL_TOKEN` `SENTRY_WEBHOOK_SECRET` `SLACK_WEBHOOK_URL`

No Anthropic / GitHub keys on the default path. Do not add them “for later” in committed files.

## Rules

- Runtime: Bun
- No `any`. `noUncheckedIndexedAccess`. Env via `process.env["KEY"]`
- Zod for every external payload
- Do not weaken HMAC or the kill-switch fail-closed contract
- Do not claim production autofix, fake MRR, or live telemetry
- Do not dump private business-ops corpus or home paths into `public/`
- Do not fire live Slack / PR paths unless explicitly asked
- Console.log is intentional MVP logging
- Autofix is a lane. The OS is the product.
