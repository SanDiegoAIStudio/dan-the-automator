import { env } from "../config";
import type { ActionJob, KillSwitchState } from "../types";

interface SlackText {
  type: "plain_text" | "mrkdwn";
  text: string;
  emoji?: boolean;
}

interface SlackBlock {
  type: "header" | "section" | "context";
  text?: SlackText;
  elements?: Array<{ type: "mrkdwn"; text: string }>;
}

interface SlackMessage {
  text: string;
  blocks?: SlackBlock[];
}

async function sendSlackMessage(message: SlackMessage): Promise<boolean> {
  const webhookUrl = env("SLACK_WEBHOOK_URL");
  if (!webhookUrl) {
    return false;
  }

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
    });
    if (!response.ok) {
      console.error(`[Slack] ${response.status} ${await response.text()}`);
      return false;
    }
    return true;
  } catch (err: unknown) {
    const text = err instanceof Error ? err.message : String(err);
    console.error(`[Slack] ${text}`);
    return false;
  }
}

export async function notifySignalIngested(job: ActionJob): Promise<boolean> {
  return sendSlackMessage({
    text: `Signal ingested: ${job.signal.title}`,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: "Signal ingested", emoji: true },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${job.signal.title}*\n\`${job.id}\` · ${job.signal.source} · ${job.signal.kind} · ${job.status}`,
        },
      },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: "Dan proposes. A human still gates." }],
      },
    ],
  });
}

export async function notifyJobUpdate(job: ActionJob, line: string): Promise<boolean> {
  return sendSlackMessage({
    text: `${line}: ${job.signal.title}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${job.signal.title}*\n${line}\n\`${job.id}\` · ${job.status}`,
        },
      },
    ],
  });
}

export async function notifyKillSwitch(state: KillSwitchState): Promise<boolean> {
  return sendSlackMessage({
    text: `Kill-switch ${state.active ? "ON" : "OFF"}: ${state.reason || "cleared"}`,
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: state.active ? "Kill-switch armed" : "Kill-switch cleared",
          emoji: true,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: state.reason ? `*${state.reason}*` : "System work is allowed again.",
        },
      },
    ],
  });
}

/** @deprecated kept for the old Sentry-shaped callers in tests */
export async function notifyIssueDetected(issue: { issueId: string; title: string }): Promise<boolean> {
  return sendSlackMessage({
    text: `New issue detected: ${issue.title}`,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: "New Issue Detected", emoji: true },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: `*${issue.title}*\nIssue ID: \`${issue.issueId}\`` },
      },
    ],
  });
}
