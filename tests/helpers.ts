import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/index";
import { clearHeartbeatsForTests } from "../src/heartbeats";
import { resetKillSwitchFileForTests } from "../src/kill-switch";
import { actionQueue } from "../src/queue";

const TOUCHED_ENV = [
  "DAN_DATA_DIR",
  "DAN_CONTROL_TOKEN",
  "DAN_HOST",
  "SENTRY_WEBHOOK_SECRET",
  "DAN_LOCAL_SHOWCASE",
  "DAN_ALLOW_UNSIGNED_WEBHOOKS",
] as const;

export const TEST_CONTROL_TOKEN = "test-control-token";
export const TEST_WEBHOOK_SECRET = "test-webhook-secret";

const envSnapshot = new Map<string, string | undefined>();

function rememberEnv(): void {
  for (const key of TOUCHED_ENV) {
    if (!envSnapshot.has(key)) {
      envSnapshot.set(key, process.env[key]);
    }
  }
}

export function restoreIsolatedEnv(): void {
  for (const [key, value] of envSnapshot) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  delete process.env["SLACK_WEBHOOK_URL"];
}

export function isolateDataDir(): string {
  rememberEnv();
  const dir = mkdtempSync(join(tmpdir(), "dan-os-"));
  process.env["DAN_DATA_DIR"] = dir;
  // source: second code review of the 2026-10-12 export
  // Auth is on unless a test sets showcase mode itself. afterEach restores env.
  process.env["DAN_CONTROL_TOKEN"] = TEST_CONTROL_TOKEN;
  process.env["SENTRY_WEBHOOK_SECRET"] = TEST_WEBHOOK_SECRET;
  delete process.env["SLACK_WEBHOOK_URL"];
  delete process.env["DAN_LOCAL_SHOWCASE"];
  delete process.env["DAN_ALLOW_UNSIGNED_WEBHOOKS"];
  delete process.env["DAN_HOST"];
  actionQueue.clear();
  resetKillSwitchFileForTests();
  clearHeartbeatsForTests();
  return dir;
}

export function app() {
  return createApp();
}

/** Sends the control token from the environment. A caller-supplied Authorization wins. */
export function controlHeaders(headers?: Record<string, string>): Record<string, string> {
  const merged: Record<string, string> = {};
  const token = process.env["DAN_CONTROL_TOKEN"];
  if (token) merged["Authorization"] = `Bearer ${token}`;
  if (headers) {
    for (const [key, value] of Object.entries(headers)) merged[key] = value;
  }
  return merged;
}

export async function signPayload(payload: string, secret: string): Promise<string> {
  const { hmacSha256Hex } = await import("../src/hmac");
  return hmacSha256Hex(secret, payload);
}

export function validSentryPayload() {
  return {
    action: "created",
    data: {
      issue: {
        id: "12345",
        title: "TypeError: Cannot read property 'save' of undefined",
        culprit: "src/components/Dashboard.tsx",
        metadata: {
          type: "TypeError",
          value: "Cannot read property 'save' of undefined - missing null check on user object",
          filename: "src/components/Dashboard.tsx",
          function: "handleSave",
        },
        permalink: "https://sentry.io/issues/12345/",
      },
    },
    actor: {
      type: "application",
      id: 1,
      name: "sentry",
    },
  };
}
