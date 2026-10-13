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
    mechanism: "A claim that contradicts the record is removed.",
    signal: "Drift findings are counted. Surprise findings should stay at zero.",
  },
  {
    id: SystemProperty.SELF_CORRECTING,
    name: "Self-correcting",
    mechanism: "Heartbeats, reflect loops, and a kill-switch that fires on measured signals taken at the time.",
    signal: "Stale heartbeat count is zero at the daily scan.",
  },
  {
    id: SystemProperty.COMPUTE_OPTIMAL,
    name: "Compute-optimal",
    mechanism: "Local inference first, paid fallback second, hard-fail terminal last. An empty response is an error.",
    signal: "Fallback spend stays inside a set budget.",
  },
  {
    id: SystemProperty.COMPOUNDING,
    name: "Compounding",
    mechanism: "Decisions, lessons, and telemetry write back into memory so the next brief is cheaper.",
    signal: "Cited memory in briefs, each claim pointing at a source.",
  },
  {
    id: SystemProperty.REVENUE_PROTECTIVE,
    name: "Revenue-protective",
    mechanism: "Programmatic kill-switch. Caps time on system work.",
    signal: "Fires on a set date or measured threshold.",
  },
];

export const PROPERTY_PRECEDENCE = SYSTEM_PROPERTY_PRECEDENCE;

export const LAYERS = [
  { id: 0, name: "Substrate", job: "Machines, network, failover." },
  { id: 1, name: "Compute serving", job: "Local first → paid fallback → frontier → hard-fail. An empty response is an error." },
  { id: 2, name: "Memory", job: "Append-only records." },
  { id: 3, name: "Knowledge ingestion", job: "Signals in: errors, meetings, telemetry, operator notes." },
  { id: 4, name: "Agent fleet", job: "Every agent has a name and wake rules." },
  { id: 5, name: "Quality gates", job: "A critic reviews each change. Human gate on outward-facing work." },
  { id: 6, name: "Observability", job: "Heartbeats, decision log, spend, session traces." },
  { id: 7, name: "Revenue protection", job: "Kill-switch and time budget. It can pause work in every other layer." },
  { id: 8, name: "Compound mechanisms", job: "Miners, indexers, quarterly drift reviews." },
] as const;
