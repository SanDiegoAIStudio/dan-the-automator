import { SystemProperty, SYSTEM_PROPERTY_PRECEDENCE, type SystemPropertyType } from "./types";

export interface PropertyCard {
  id: SystemPropertyType;
  name: string;
  mechanism: string;
  signal: string;
}

/**
 * Public-safe excerpts of THE-SYSTEM operating properties.
 * Precedence when they conflict: revenue > truth > self-correct > compound > compute.
 */
export const PROPERTIES: readonly PropertyCard[] = [
  {
    id: SystemProperty.TRUTH_ANCHORED,
    name: "Truth-anchored",
    mechanism: "Ground-truth audits and a stack-reality critic. Claims die if they contradict the record.",
    signal: "Drift findings are counted. Surprise findings should stay at zero.",
  },
  {
    id: SystemProperty.SELF_CORRECTING,
    name: "Self-correcting",
    mechanism: "Heartbeats, reflect loops, and a kill-switch that fires on measured signals — not memory.",
    signal: "Stale heartbeat count is zero at the daily scan.",
  },
  {
    id: SystemProperty.COMPUTE_OPTIMAL,
    name: "Compute-optimal",
    mechanism: "Local inference first, paid fallback second, hard-fail terminal last. Never silent empty completions.",
    signal: "Fallback fire-rate stays bounded; cost is recoverable, trust is not.",
  },
  {
    id: SystemProperty.COMPOUNDING,
    name: "Compounding",
    mechanism: "Decisions, lessons, and telemetry write back into memory so the next brief is cheaper.",
    signal: "Cited memory in briefs, not vibes.",
  },
  {
    id: SystemProperty.REVENUE_PROTECTIVE,
    name: "Revenue-protective",
    mechanism: "Programmatic kill-switch + time-budget cap. System work does not eat the cash engines.",
    signal: "Kill-switch fires when the calendar or a measured tripwire says so.",
  },
];

export const PROPERTY_PRECEDENCE = SYSTEM_PROPERTY_PRECEDENCE;

export const LAYERS = [
  { id: 0, name: "Substrate", job: "Machines, mesh, failover. The riverbed has to stay up." },
  { id: 1, name: "Compute serving", job: "Local first → paid fallback → frontier → hard-fail. No silent empties." },
  { id: 2, name: "Memory", job: "Append-only truth + derived indexes. Files are truth; vectors are derived." },
  { id: 3, name: "Knowledge ingestion", job: "Signals in: errors, meetings, telemetry, operator notes." },
  { id: 4, name: "Agent fleet", job: "Named agents with wake rules. Cute unnamed helpers are not in the system." },
  { id: 5, name: "Quality gates", job: "Nothing ships without a critic pass. Human gate on outward-facing work." },
  { id: 6, name: "Observability", job: "Heartbeats, decision log, spend, session traces." },
  { id: 7, name: "Revenue protection", job: "Kill-switch + time budget. This layer vetoes the rest." },
  { id: 8, name: "Compound mechanisms", job: "Miners, indexers, quarterly drift reviews. The flywheel under the floor." },
] as const;
