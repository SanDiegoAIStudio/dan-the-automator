# Dan the Automator

**Dan is the public face of a self-correcting business operating system — agent fleet, kill-switch, truth audits, flywheel — not yet another autofix bot.**

This repo is the showcase control plane for [San Diego AI Studio](https://sandiegoaistudio.com) / Luc Face. The studio runs as one designed universe: a riverbed (the Intelligent OS) under a set of cash engines, turned by a flywheel that **attracts → converts → delivers → compounds**. Dan is the automator on that riverbed. He ingests a signal, diagnoses it, proposes an action, and **stops for a human**. He does not silently “heal production in two minutes.” That was the old README. It was vapor.

**Ethos:** Casual Building for Serious Leverage.

<p align="center">
  <a href="./public/index.html"><strong>Open the living cutaway →</strong></a>
  &nbsp;·&nbsp;
  <a href="https://sandiegoaistudio.com">sandiegoaistudio.com</a>
</p>

The cutaway is the showpiece: pan, zoom, guided tour, searchable node index, status legend, flywheel particles. Statuses are an **illustrative snapshot** (`public/status.json`), not a live bank or telemetry feed.

---

## The point, in one stack

```
⑤  STORE OF VALUE     land → energy on an owned roof → rented compute / robots
④  THE MOAT           relationship graph + community + accumulated fleet
③  CONVERSION         engine cash → an owner-independent business
②  THE ARMS           SDAIS (the heart) · AFP (relationships / cash now) · shots (Struvo, …)
①  LEVERAGE           agent fleet / Intelligent OS  ← Dan lives here
⓪  THE WHY            comprehend the universe by building it — and hand the leverage down
```

SDAIS is the heart. Products are **shots on goal**, not main characters. Software gets cheaper to copy every quarter; the graph of builders you actually made more capable does not.

```
                    THE WORLD
                        │ attention
                        ▼
                 ┌──────────────┐
                 │    FUNNEL    │  stranger → advocate
                 │  SDAIS heart │
                 └──────┬───────┘
                        │
        ┌───────────────┼────────────────┐
        ▼               ▼                ▼
     STRUVO            AFP           OTHER SHOTS
   (construction)  (outreach)     (apps / intel / CRM)
        │               │                │
        └─────────── dollars ────────────┘
                        │
                        ▼
              $10K → $30K MRR GATE
              no hard assets until it opens
                        │
                        ▼
                    ENDGAME
              land · solar · rented compute

════════════════ THE RIVERBED (locked) ════════════════
  kill-switch · heartbeats · memory · quarantine
  agent cores (lit + dormant) · quality gates
  Dan: ingest → diagnose → propose → HUMAN GATE → report
```

The flywheel is physical: every arm exhales attention back into the funnel. Judge a **funnel** asset on attention. Judge an **engine** asset on dollars. Mixing those tests is how you plateau.

---

## Five properties (or it is not in the system)

| # | Property | How you know it’s working |
|---|---|---|
| 1 | **Truth-anchored** | Drift gets found. Surprise findings stay at zero. |
| 2 | **Self-correcting** | Heartbeats, reflect loops, kill-switch on measured signals. |
| 3 | **Compute-optimal** | Local first → paid fallback → hard-fail. No silent empties. |
| 4 | **Compounding** | Decisions write back. The next brief is cheaper. |
| 5 | **Revenue-protective** | Kill-switch + time budget. System work does not eat the engines. |

When they conflict: **revenue > truth > self-correct > compound > compute.** Cost is recoverable. Trust isn’t.

Cute features that require the operator to remember to invoke them are **not in the system.**

---

## What works today vs the roadmap

### Works today (this repo)

- Living cutaway at `/` — pan/zoom, tour, index, illustrative statuses
- HTTP control plane on Bun + Hono (`GET /health`, `GET /os`)
- **Kill-switch** with THE-SYSTEM contract: missing file → fail-open; corrupt file → fail-closed; `dan ks on <reason>`
- **Heartbeat registry** with stale detection (2× cadence)
- **Signal intake → diagnose → propose → human gate → report**
- Sentry HMAC webhook as **one intake adapter**, not the product
- Optional Slack notify (skipped if `SLACK_WEBHOOK_URL` is unset)
- CLI: `dan ingest` / `dan approve` / `dan reject` / `dan ks` / `dan heartbeat`
- Optional `DAN_CONTROL_TOKEN` on mutating routes
- Tests + `bunx tsc --noEmit`

Queue is **in-memory**. Restart and the jobs are gone. That is honest for a Phase-1 skeleton.

### Not this repo (do not invent a demo that claims it)

- No live Claude autofix writing your production app
- No auto-opened GitHub PRs on the default path
- No Redis / Postgres / Bull (the old README named them; the code never had them)
- No live MRR gauge, customer counts, or “minutes to fix”
- The cutaway is **not** wired to private business-ops telemetry

Autofix is one **lane**: an error signal with a file hint becomes an `autofix-candidate` proposal. A human still gates. Wiring a model + `git` write-back is roadmap, behind the same kill-switch.

### Roadmap (named, not dated)

- Persist jobs and heartbeats
- Optional live diagnose (Claude) behind `--live` + kill-switch
- Optional GitHub propose-PR lane, still human-gated
- Safe `status.json` refresh from public product health only
- Compound layer: decision log + weekly drift note

---

## Quick start

```bash
bun install
bun test
bun run typecheck
bun dev          # http://localhost:3456  ← the cutaway
```

```bash
# kill-switch
bun run src/cli.ts ks on "revenue week"
bun run src/cli.ts ks off

# signal → proposal → gate
bun run src/cli.ts ingest --title "STT failover flapped" --kind error --file src/stt.ts
bun run src/cli.ts jobs
bun run src/cli.ts approve job_<id>

# HTTP
curl -s localhost:3456/health | jq
curl -s localhost:3456/os | jq .honest
curl -s -X POST localhost:3456/signals \
  -H 'Content-Type: application/json' \
  -d '{"source":"operator","kind":"manual","title":"look at the radar"}'
```

Open `public/index.html` from disk if you just want the map. `status.json` overlays when the file is served over HTTP.

---

## Endpoints

| Method | Path | What it does |
|--------|------|----------------|
| GET | `/` | Living cutaway |
| GET | `/status.json` | Illustrative node statuses |
| GET | `/health` | Process + kill-switch + heartbeats + queue |
| GET | `/os` | Properties, 8-layer stack, fleet roster |
| GET | `/kill-switch` | Current switch |
| POST | `/kill-switch` | Arm / clear (`{ active, reason }`) |
| GET/POST | `/heartbeats` | Registry + pulse |
| POST | `/signals` | Generic typed intake |
| POST | `/webhook/sentry` | Sentry adapter (HMAC) |
| POST | `/trigger` | Manual intake (dev) |
| GET | `/jobs` | List (`?status=`) |
| GET | `/jobs/:id` | One job |
| POST | `/jobs/:id/approve` | Human gate |
| POST | `/jobs/:id/reject` | Human gate |

Mutating control routes take `Authorization: Bearer $DAN_CONTROL_TOKEN` when that env is set. Sentry keeps its own HMAC. `/trigger` is a local convenience, not a production door.

---

## Brand

San Diego AI Studio builds in public from San Diego. Luc Face is the operator studio behind it. Dan is the automator — the thing that keeps the machine self-correcting so a tiny team can run more than a tiny team should.

If you want the community, start at [sandiegoaistudio.com](https://sandiegoaistudio.com). If you want the map of the machine, stay on the cutaway.

---

## License

MIT
