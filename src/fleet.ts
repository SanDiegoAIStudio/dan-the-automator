/**
 * Public-safe roster of the Intelligent OS fleet.
 * Names only — no disk paths, no private handles.
 */
export const ACTIVE_AGENTS = [
  "chief-of-staff",
  "daily-ops",
  "file-oracle",
  "security-lead",
  "content-fanout",
  "yt-producer",
  "web-producer",
  "freelance-sales",
  "enterprise-controller",
  "struvo-ops-lead",
  "struvo-dev",
  "struvo-lead-router",
  "struvo-pricing-checker",
  "struvo-roadmap-decider",
  "twentyfive-dev",
  "link-preview",
  "image-preview",
  "research-proxy",
] as const;

export const DORMANT_AGENTS = [
  "market-intel",
  "account-health",
  "insight-synth",
  "post-demo-nurture",
  "continuity-broker",
  "reactivation",
  "referral",
  "vertical-cloner",
  "cap-table",
  "scorp-controller",
  "challenge-coach",
  "quality-arb",
  "audio-to-asset",
  "pdf-upsell",
  "finalize-audit",
  "finflow-dev",
  "futuretree-dev",
] as const;

export function fleetSummary() {
  return {
    active: ACTIVE_AGENTS.length,
    dormant: DORMANT_AGENTS.length,
    agents: {
      active: [...ACTIVE_AGENTS],
      dormant: [...DORMANT_AGENTS],
    },
    rule: "Dormant agents wake on keyword. Adding an agent without a critic is not in the system.",
  };
}
