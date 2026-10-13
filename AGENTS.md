# Dan The Automator Agent Instructions

Read `CLAUDE.md` first. This repo is the public Intelligent OS control plane for San Diego AI Studio / Luc Face: kill-switch, heartbeats, typed signal intake, human-gated proposals, and a living cutaway.

## Commands

```bash
bun install
bun dev
bun test
bun run typecheck
bun run src/cli.ts help
```

## Rules

- Preserve HMAC verification, Zod validation, and the kill-switch fail-open / fail-closed contract.
- Do not weaken tokens or ship secrets, home paths, private IPs, or client names in `public/`.
- Autofix is one optional lane. Do not revive a Sentry-only “heals prod in minutes” story.
- Do not trigger live Slack, GitHub write-back, or paid model calls unless explicitly asked.
- Keep the cutaway statuses illustrative unless you wire a safe static `status.json`.
