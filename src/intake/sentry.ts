import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { authorizeControl } from "../auth";
import { verifyHmacSha256 } from "../hmac";
import { ingestSignal } from "../pipeline";
import { env, showcaseHostBlock, showcaseMutationBlock, webhookSecret } from "../config";
import { ManualTriggerSchema, SentryWebhookPayloadSchema, SignalSchema, signalLimitError, type Signal } from "../types";

const ERROR_INVALID_JSON = "Invalid JSON";
const ERROR_INVALID_PAYLOAD = "Invalid payload";
const ERROR_REQUEST_FAILED = "request failed";
const ERROR_WEBHOOK_SECRET = "webhook secret not configured";
const ERROR_INVALID_SIGNATURE = "Invalid signature";
const ERROR_UNAUTHORIZED = "Unauthorized";
const ERROR_CONTROL_TOKEN = "control token not configured";

function errorDetail(detail: unknown): string {
  if (detail instanceof Error) {
    const stack = detail.stack;
    if (stack && stack.includes(detail.message)) return stack;
    return stack ? `${detail.message}\n${stack}` : detail.message;
  }
  return String(detail);
}

function errorFields(error: string, detail: unknown): { error: string; id: string } {
  const id = randomBytes(4).toString("hex");
  console.error(`[Dan] error ${id} ${errorDetail(detail)}`);
  return { error, id };
}

export const sentryWebhook = new Hono();

sentryWebhook.onError((err, c) => {
  return c.json(errorFields(ERROR_REQUEST_FAILED, err), 500);
});

async function verifySentrySignature(
  body: string,
  signature: string | undefined,
): Promise<"ok" | "unconfigured" | "invalid"> {
  const secret = webhookSecret();
  if (!secret) {
    if (env("DAN_ALLOW_UNSIGNED_WEBHOOKS") === "1") return "ok";
    return "unconfigured";
  }
  if (!signature) {
    return "invalid";
  }
  const valid = await verifyHmacSha256(secret, body, signature);
  return valid ? "ok" : "invalid";
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
  const showcase = showcaseMutationBlock(c.req.header("content-type"), c.req.header("origin"));
  if (showcase) return c.json(errorFields(showcase.error, showcase.error), showcase.status);
  const rawBody = await c.req.text();
  const signature = c.req.header("sentry-hook-signature");

  const verdict = await verifySentrySignature(rawBody, signature);
  if (verdict === "unconfigured") {
    return c.json(errorFields(ERROR_WEBHOOK_SECRET, ERROR_WEBHOOK_SECRET), 503);
  }
  if (verdict === "invalid") {
    return c.json(errorFields(ERROR_INVALID_SIGNATURE, ERROR_INVALID_SIGNATURE), 401);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch (err: unknown) {
    return c.json(errorFields(ERROR_INVALID_JSON, err), 400);
  }

  const parsed = SentryWebhookPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return c.json(errorFields(ERROR_INVALID_PAYLOAD, parsed.error), 400);
  }

  const { action, data } = parsed.data;
  if (action !== "created" && action !== "triggered") {
    return c.json({ status: "ignored", reason: `Action '${action}' not processed` });
  }

  const signal = sentryToSignal(data.issue);
  const checked = SignalSchema.safeParse(signal);
  if (!checked.success) {
    const limit = signalLimitError(checked.error);
    if (limit) return c.json(errorFields(limit, checked.error), 400);
    return c.json(errorFields(ERROR_INVALID_PAYLOAD, checked.error), 400);
  }

  try {
    const job = ingestSignal(checked.data);
    return c.json({
      status: "queued",
      jobId: job.id,
      issueId: data.issue.id,
      jobStatus: job.status,
      lane: "autofix",
    });
  } catch (err: unknown) {
    return c.json(errorFields(ERROR_REQUEST_FAILED, err), 500);
  }
});

function controlDenied(header: string | undefined): { error: string; status: 401 | 503 } | null {
  const verdict = authorizeControl(header);
  if (verdict === "ok") return null;
  if (verdict === "unconfigured") return { error: ERROR_CONTROL_TOKEN, status: 503 };
  return { error: ERROR_UNAUTHORIZED, status: 401 };
}

sentryWebhook.post("/trigger", async (c) => {
  const host = showcaseHostBlock(c.req.header("host"));
  if (host) return c.json(errorFields(host.error, host.error), host.status);
  const showcase = showcaseMutationBlock(c.req.header("content-type"), c.req.header("origin"));
  if (showcase) return c.json(errorFields(showcase.error, showcase.error), showcase.status);
  const blocked = controlDenied(c.req.header("Authorization"));
  if (blocked) return c.json(errorFields(blocked.error, blocked.error), blocked.status);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch (err: unknown) {
    return c.json(errorFields(ERROR_INVALID_JSON, err), 400);
  }

  const parsed = ManualTriggerSchema.safeParse(body);
  if (!parsed.success) {
    const limit = signalLimitError(parsed.error);
    if (limit) return c.json(errorFields(limit, parsed.error), 400);
    return c.json(errorFields(ERROR_INVALID_PAYLOAD, parsed.error), 400);
  }

  const data = parsed.data;
  const ref = data.ref ?? data.issueId ?? `manual-${Date.now()}`;
  try {
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
  } catch (err: unknown) {
    return c.json(errorFields(ERROR_REQUEST_FAILED, err), 500);
  }
});
