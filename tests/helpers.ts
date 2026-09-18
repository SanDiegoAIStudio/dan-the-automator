import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/index";
import { clearHeartbeatsForTests } from "../src/heartbeats";
import { resetKillSwitchFileForTests } from "../src/kill-switch";
import { actionQueue } from "../src/queue";

export function isolateDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dan-os-"));
  process.env["DAN_DATA_DIR"] = dir;
  delete process.env["DAN_CONTROL_TOKEN"];
  delete process.env["SLACK_WEBHOOK_URL"];
  delete process.env["SENTRY_WEBHOOK_SECRET"];
  actionQueue.clear();
  resetKillSwitchFileForTests();
  clearHeartbeatsForTests();
  return dir;
}

export function app() {
  return createApp();
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
