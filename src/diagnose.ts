import { RecommendedAction, SystemProperty, type Diagnosis, type ProposedAction, type Signal } from "./types";

export function diagnose(signal: Signal): Diagnosis {
  if (signal.kind === "revenue") {
    return {
      summary: "Held until a person reviews it.",
      property: SystemProperty.REVENUE_PROTECTIVE,
      recommendedAction: RecommendedAction.HOLD,
      confidence: "high",
    };
  }

  if (signal.kind === "heartbeat") {
    return {
      summary: "Heartbeat signal. Queued for review.",
      property: SystemProperty.SELF_CORRECTING,
      recommendedAction: RecommendedAction.NOTIFY,
      confidence: "high",
    };
  }

  if (signal.kind === "error" && signal.file) {
    return {
      summary: `Error in ${signal.file}. Queued for review.`,
      property: SystemProperty.SELF_CORRECTING,
      recommendedAction: RecommendedAction.AUTOFIX_CANDIDATE,
      confidence: "medium",
    };
  }

  if (signal.kind === "error") {
    return {
      summary: "Error with no file path. Queued for review.",
      property: SystemProperty.TRUTH_ANCHORED,
      recommendedAction: RecommendedAction.REVIEW,
      confidence: "medium",
    };
  }

  if (signal.kind === "content") {
    return {
      summary: "Content signal. Queued for review.",
      property: SystemProperty.COMPOUNDING,
      recommendedAction: RecommendedAction.REVIEW,
      confidence: "medium",
    };
  }

  return {
    summary: "Ops signal. Queued for review.",
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
      note: "Proposal only. No code is written and no PR is opened.",
    },
  };
}

export function formatAutofixPrompt(signal: Signal): string {
  const parts = [
    "Propose the smallest possible fix.",
    `Title: ${signal.title}`,
  ];
  if (signal.body) parts.push(`Analysis: ${signal.body}`);
  if (signal.file) parts.push(`File: ${signal.file}`);
  if (signal.line !== undefined) parts.push(`Line: ${signal.line}`);
  parts.push("Return JSON { file, oldCode, newCode, explanation }.");
  parts.push("Queued for review.");
  return parts.join("\n");
}
