import { Hono } from "hono";
import { verifyHmacSha256 } from "../hmac";
import { ingestSignal } from "../pipeline";
import { env } from "../config";
import { ManualTriggerSchema, SentryWebhookPayloadSchema, type Signal } from "../types";

export const sentryWebhook = new Hono();

async function verifySentrySignature(body: string, signature: string | undefined): Promise<boolean> {
  const secret = env("SENTRY_WEBHOOK_SECRET");
  if (!secret) {
    console.warn("[Webhook] SENTRY_WEBHOOK_SECRET not set — skipping signature verification");
    return true;
  }
  if (!signature) {
    return false;
  }
  return verifyHmacSha256(secret, body, signature);
}

function sentryToSignal(issue: {
  id: string;
  title: string;
  metadata?: { value?: string; filename?: string };
}): Signal {
  return {
    source: "sentry",
    kind: "error",
    title: issue.title,
    body: issue.metadata?.value,
    ref: issue.id,
    file: issue.metadata?.filename,
  };
}

sentryWebhook.post("/sentry", async (c) => {
  const rawBody = await c.req.text();
  const signature = c.req.header("sentry-hook-signature");

  const isValid = await verifySentrySignature(rawBody, signature);
  if (!isValid) {
    return c.json({ error: "Invalid signature" }, 401);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const parsed = SentryWebhookPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return c.json({ error: "Invalid payload", details: parsed.error.flatten() }, 400);
  }

  const { action, data } = parsed.data;
  if (action !== "created" && action !== "triggered") {
    return c.json({ status: "ignored", reason: `Action '${action}' not processed` });
  }

  const job = ingestSignal(sentryToSignal(data.issue));

  return c.json({
    status: "queued",
    jobId: job.id,
    issueId: data.issue.id,
    jobStatus: job.status,
    lane: "autofix",
  });
});

sentryWebhook.post("/trigger", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const parsed = ManualTriggerSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid payload", details: parsed.error.flatten() }, 400);
  }

  const data = parsed.data;
  const ref = data.ref ?? data.issueId ?? `manual-${Date.now()}`;
  const job = ingestSignal({
    source: data.source ?? "operator",
    kind: data.kind ?? "manual",
    title: data.title,
    body: data.body ?? data.seerAnalysis,
    ref,
    file: data.file,
    line: data.line,
  });

  return c.json({
    status: "queued",
    jobId: job.id,
    issueId: ref,
    jobStatus: job.status,
  });
});
