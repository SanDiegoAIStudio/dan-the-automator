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

const PLAIN_TEXT_MAX = 150;

/**
 * Slack mrkdwn. & < > become entities. * _ ~ lose their control meaning by
 * sitting in a one-character code span. A backtick cannot sit in a code span,
 * so it becomes a fullwidth grave accent (U+FF40), which is not a delimiter.
 */
export function escapeSlackMrkdwn(value: string): string {
  let out = "";
  for (const ch of value) {
    if (ch === "&") out += "&amp;";
    else if (ch === "<") out += "&lt;";
    else if (ch === ">") out += "&gt;";
    else if (ch === "*") out += "`*`";
    else if (ch === "_") out += "`_`";
    else if (ch === "~") out += "`~`";
    else if (ch === "`") out += "\uFF40";
    else out += ch;
  }
  return out;
}

/** plain_text is not markup. Slack header text is capped at 150 characters. */
export function slackPlainText(value: string): string {
  if (value.length <= PLAIN_TEXT_MAX) return value;
  return value.slice(0, PLAIN_TEXT_MAX);
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

/** Job ids stay literal inside one code span, including underscores. */
function slackJobId(id: string): string {
  return `\`${id}\``;
}

function signalMrkdwn(job: ActionJob): string {
  const title = escapeSlackMrkdwn(job.signal.title);
  const source = escapeSlackMrkdwn(job.signal.source);
  const kind = escapeSlackMrkdwn(job.signal.kind);
  return `*${title}*\n${slackJobId(job.id)} · ${source} · ${kind} · ${job.status}`;
}

export async function notifySignalIngested(job: ActionJob): Promise<boolean> {
  const title = escapeSlackMrkdwn(job.signal.title);
  return sendSlackMessage({
    text: `Signal ingested: ${title}`,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: slackPlainText("Signal ingested"), emoji: true },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: signalMrkdwn(job),
        },
      },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: "A person approves or rejects this job." }],
      },
    ],
  });
}

export async function notifyJobUpdate(job: ActionJob, line: string): Promise<boolean> {
  const title = escapeSlackMrkdwn(job.signal.title);
  return sendSlackMessage({
    text: `${line}: ${title}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${title}*\n${line}\n${slackJobId(job.id)} · ${job.status}`,
        },
      },
    ],
  });
}

export async function notifyKillSwitch(state: KillSwitchState): Promise<boolean> {
  const reason = escapeSlackMrkdwn(state.reason);
  return sendSlackMessage({
    text: `Kill-switch ${state.active ? "ON" : "OFF"}: ${state.reason ? reason : "cleared"}`,
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: slackPlainText(state.active ? "Kill-switch armed" : "Kill-switch cleared"),
          emoji: true,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: state.reason ? `*${reason}*` : "System work is allowed again.",
        },
      },
    ],
  });
}

/** @deprecated kept for the old Sentry-shaped callers in tests */
export async function notifyIssueDetected(issue: { issueId: string; title: string }): Promise<boolean> {
  const title = escapeSlackMrkdwn(issue.title);
  const id = escapeSlackMrkdwn(issue.issueId);
  return sendSlackMessage({
    text: `New issue detected: ${title}`,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: slackPlainText("New Issue Detected"), emoji: true },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: `*${title}*\nIssue ID: \`${id}\`` },
      },
    ],
  });
}
