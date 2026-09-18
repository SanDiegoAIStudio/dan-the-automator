import { RecommendedAction, SystemProperty, type Diagnosis, type ProposedAction, type Signal } from "./types";

export function diagnose(signal: Signal): Diagnosis {
  if (signal.kind === "revenue") {
    return {
      summary: "Revenue-adjacent signal. Hold automation and keep a human on the dollar path.",
      property: SystemProperty.REVENUE_PROTECTIVE,
      recommendedAction: RecommendedAction.HOLD,
      confidence: "high",
    };
  }

  if (signal.kind === "heartbeat") {
    return {
      summary: "Heartbeat / staleness signal. Page the operator if the beat is late; do not invent work.",
      property: SystemProperty.SELF_CORRECTING,
      recommendedAction: RecommendedAction.NOTIFY,
      confidence: "high",
    };
  }

  if (signal.kind === "error" && signal.file) {
    return {
      summary: `Error with a file hint (${signal.file}). Candidate for the autofix lane — still human-gated.`,
      property: SystemProperty.SELF_CORRECTING,
      recommendedAction: RecommendedAction.AUTOFIX_CANDIDATE,
      confidence: "medium",
    };
  }

  if (signal.kind === "error") {
    return {
      summary: "Error without a file hint. Diagnose further before touching code.",
      property: SystemProperty.TRUTH_ANCHORED,
      recommendedAction: RecommendedAction.REVIEW,
      confidence: "medium",
    };
  }

  if (signal.kind === "content") {
    return {
      summary: "Content / attention signal. Compounds the flywheel; does not spend engine hours.",
      property: SystemProperty.COMPOUNDING,
      recommendedAction: RecommendedAction.REVIEW,
      confidence: "medium",
    };
  }

  return {
    summary: "Operator or ops signal. Review, then act. Cute unattended features are not in the system.",
    property: SystemProperty.TRUTH_ANCHORED,
    recommendedAction: RecommendedAction.REVIEW,
    confidence: "low",
  };
}

export function propose(diagnosis: Diagnosis, signal: Signal): ProposedAction {
  const blastRadius = diagnosis.recommendedAction === RecommendedAction.AUTOFIX_CANDIDATE ? "high" : "low";
  const lane =
    diagnosis.recommendedAction === RecommendedAction.AUTOFIX_CANDIDATE
      ? "autofix"
      : diagnosis.property === SystemProperty.REVENUE_PROTECTIVE
        ? "revenue"
        : signal.kind === "ops" || signal.kind === "heartbeat"
          ? "ops"
          : "intake";

  return {
    type: diagnosis.recommendedAction,
    summary: `${diagnosis.recommendedAction} · ${signal.title}`,
    requiresHumanGate: true,
    blastRadius,
    lane,
    details: {
      source: signal.source,
      kind: signal.kind,
      property: diagnosis.property,
      ref: signal.ref ?? "",
      file: signal.file ?? "",
      note: "This control plane proposes. It does not silently write production code or open live PRs.",
    },
  };
}

export function formatAutofixPrompt(signal: Signal): string {
  const parts = [
    "Propose the smallest possible fix. Do not apply it.",
    `Title: ${signal.title}`,
  ];
  if (signal.body) parts.push(`Analysis: ${signal.body}`);
  if (signal.file) parts.push(`File: ${signal.file}`);
  if (signal.line !== undefined) parts.push(`Line: ${signal.line}`);
  parts.push("Return JSON { file, oldCode, newCode, explanation } for a human to gate.");
  return parts.join("\n");
}
