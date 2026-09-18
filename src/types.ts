import { z } from "zod";

// ── Operating properties (THE-SYSTEM) ───────────────────────────────

export const SystemProperty = {
  TRUTH_ANCHORED: "truth-anchored",
  SELF_CORRECTING: "self-correcting",
  COMPUTE_OPTIMAL: "compute-optimal",
  COMPOUNDING: "compounding",
  REVENUE_PROTECTIVE: "revenue-protective",
} as const;

export type SystemPropertyType = (typeof SystemProperty)[keyof typeof SystemProperty];

export const SYSTEM_PROPERTY_PRECEDENCE: readonly SystemPropertyType[] = [
  SystemProperty.REVENUE_PROTECTIVE,
  SystemProperty.TRUTH_ANCHORED,
  SystemProperty.SELF_CORRECTING,
  SystemProperty.COMPOUNDING,
  SystemProperty.COMPUTE_OPTIMAL,
];

// ── Signals ─────────────────────────────────────────────────────────

export const SignalKind = {
  ERROR: "error",
  HEARTBEAT: "heartbeat",
  REVENUE: "revenue",
  CONTENT: "content",
  OPS: "ops",
  MANUAL: "manual",
} as const;

export type SignalKindType = (typeof SignalKind)[keyof typeof SignalKind];

export const SignalSchema = z.object({
  source: z.string().min(1),
  kind: z.enum(["error", "heartbeat", "revenue", "content", "ops", "manual"]),
  title: z.string().min(1),
  body: z.string().optional(),
  ref: z.string().optional(),
  file: z.string().optional(),
  line: z.number().int().positive().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type Signal = z.infer<typeof SignalSchema>;

export const ManualTriggerSchema = z.object({
  issueId: z.string().min(1).optional(),
  title: z.string().min(1),
  seerAnalysis: z.string().optional(),
  file: z.string().optional(),
  line: z.number().int().positive().optional(),
  source: z.string().min(1).optional(),
  kind: z.enum(["error", "heartbeat", "revenue", "content", "ops", "manual"]).optional(),
  body: z.string().optional(),
  ref: z.string().optional(),
});

export type ManualTriggerPayload = z.infer<typeof ManualTriggerSchema>;

// ── Sentry (one intake adapter) ─────────────────────────────────────

export const SentryIssueDataSchema = z.object({
  id: z.string(),
  title: z.string(),
  culprit: z.string().optional(),
  metadata: z
    .object({
      type: z.string().optional(),
      value: z.string().optional(),
      filename: z.string().optional(),
      function: z.string().optional(),
    })
    .optional(),
  permalink: z.string().url().optional(),
});

export const SentryWebhookPayloadSchema = z.object({
  action: z.string(),
  data: z.object({
    issue: SentryIssueDataSchema,
  }),
  actor: z
    .object({
      type: z.string(),
      id: z.number().optional(),
      name: z.string().optional(),
    })
    .optional(),
});

export type SentryIssueData = z.infer<typeof SentryIssueDataSchema>;
export type SentryWebhookPayload = z.infer<typeof SentryWebhookPayloadSchema>;

// ── Kill-switch ─────────────────────────────────────────────────────

export const KillSwitchSchema = z.object({
  schema_version: z.number().int().positive(),
  active: z.boolean(),
  reason: z.string(),
  since: z.string().datetime().nullable(),
  set_by: z.enum(["human", "agent"]),
  expires_at: z.string().datetime().optional(),
});

export type KillSwitchState = z.infer<typeof KillSwitchSchema>;

export const DEFAULT_KILL_SWITCH: KillSwitchState = {
  schema_version: 1,
  active: false,
  reason: "",
  since: null,
  set_by: "human",
};

// ── Heartbeats ──────────────────────────────────────────────────────

export const HeartbeatSchema = z.object({
  name: z.string().min(1),
  at: z.string().datetime(),
  cadenceSeconds: z.number().int().positive(),
});

export type Heartbeat = z.infer<typeof HeartbeatSchema>;

// ── Diagnosis + proposal ────────────────────────────────────────────

export const RecommendedAction = {
  REVIEW: "review",
  NOTIFY: "notify",
  AUTOFIX_CANDIDATE: "autofix-candidate",
  HOLD: "hold",
} as const;

export type RecommendedActionType = (typeof RecommendedAction)[keyof typeof RecommendedAction];

export const DiagnosisSchema = z.object({
  summary: z.string(),
  property: z.enum([
    "truth-anchored",
    "self-correcting",
    "compute-optimal",
    "compounding",
    "revenue-protective",
  ]),
  recommendedAction: z.enum(["review", "notify", "autofix-candidate", "hold"]),
  confidence: z.enum(["low", "medium", "high"]),
});

export type Diagnosis = z.infer<typeof DiagnosisSchema>;

export const ProposedActionSchema = z.object({
  type: z.enum(["review", "notify", "autofix-candidate", "hold"]),
  summary: z.string(),
  requiresHumanGate: z.literal(true),
  blastRadius: z.enum(["low", "high"]),
  lane: z.enum(["intake", "autofix", "ops", "revenue"]),
  details: z.record(z.string()),
});

export type ProposedAction = z.infer<typeof ProposedActionSchema>;

// ── Jobs ────────────────────────────────────────────────────────────

export const JobStatus = {
  PENDING: "pending",
  DIAGNOSING: "diagnosing",
  PROPOSED: "proposed",
  HELD: "held",
  APPROVED: "approved",
  REJECTED: "rejected",
  REPORTED: "reported",
  FAILED: "failed",
} as const;

export type JobStatusType = (typeof JobStatus)[keyof typeof JobStatus];

export interface ActionJob {
  id: string;
  signal: Signal;
  status: JobStatusType;
  createdAt: Date;
  updatedAt: Date;
  diagnosis: Diagnosis | undefined;
  proposal: ProposedAction | undefined;
  gate: { decidedBy: "human"; decision: "approved" | "rejected"; reason: string } | undefined;
  error: string | undefined;
}

export function serializeJob(job: ActionJob) {
  return {
    id: job.id,
    signal: job.signal,
    status: job.status,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    diagnosis: job.diagnosis,
    proposal: job.proposal,
    gate: job.gate,
    error: job.error,
  };
}

// ── Slack ───────────────────────────────────────────────────────────

export type SlackNotificationType = "signal_ingested" | "proposal_ready" | "kill_switch" | "job_gated";
