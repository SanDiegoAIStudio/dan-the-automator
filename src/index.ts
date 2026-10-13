import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { authorizeControl } from "./auth";
import {
  controlToken,
  dataDir,
  dataDirLogLine,
  env,
  localShowcase,
  SERVICE_NAME,
  serverHost,
  serverPort,
  showcaseHostBlock,
  showcaseMutationBlock,
  startupRefusal,
  VERSION,
  webhookSecret,
} from "./config";
import { fleetSummary } from "./fleet";
import { listHeartbeats, writeHeartbeat } from "./heartbeats";
import { sentryWebhook } from "./intake/sentry";
import { readKillSwitch, setKillSwitch, type KillSwitchRead } from "./kill-switch";
import { notifyKillSwitch } from "./notify/slack";
import { decideJob, ingestSignal } from "./pipeline";
import { LAYERS, PROPERTIES } from "./properties";
import { actionQueue } from "./queue";
import { z } from "zod";
import { HeartbeatSchema, JobStatus, SignalSchema, serializeJob, signalLimitError, type JobStatusType } from "./types";

const JOB_STATUSES = new Set<string>(Object.values(JobStatus));

const ERROR_UNAUTHORIZED = "Unauthorized";
const ERROR_CONTROL_TOKEN = "control token not configured";
const ERROR_INVALID_JSON = "Invalid JSON";
const ERROR_INVALID_PAYLOAD = "Invalid payload";
const ERROR_UNKNOWN_STATUS = "Unknown status";
const ERROR_JOB_NOT_FOUND = "Job not found";
const ERROR_COULD_NOT = "could_not";
const ERROR_REQUEST_FAILED = "request failed";

function nodeCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !("code" in err)) return undefined;
  const code = err.code;
  return typeof code === "string" ? code : undefined;
}

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

function heartbeatFolderProblem(): unknown | undefined {
  try {
    readdirSync(join(dataDir(), "heartbeats"));
    return undefined;
  } catch (err: unknown) {
    if (nodeCode(err) === "ENOENT") return undefined;
    return err;
  }
}

function killSwitchReadProblem(): unknown {
  try {
    readFileSync(join(dataDir(), "kill-switch.json"), "utf8");
    return new Error("kill-switch unreadable");
  } catch (err: unknown) {
    return err;
  }
}

function clientFailure(err: unknown): { error: string; status: 400 | 404 } {
  const message = err instanceof Error ? err.message : "";
  if (
    message === "kill-switch on requires a reason" ||
    message === "could not write kill-switch.json" ||
    message === "could not write kill-switch.log"
  ) {
    return { error: message, status: 400 };
  }
  if (message.includes("not found")) return { error: ERROR_JOB_NOT_FOUND, status: 404 };
  return { error: ERROR_REQUEST_FAILED, status: 400 };
}

function controlBlock(header: string | undefined): { error: string; status: 401 | 503 } | null {
  const verdict = authorizeControl(header);
  if (verdict === "ok") return null;
  if (verdict === "unconfigured") {
    return { error: ERROR_CONTROL_TOKEN, status: 503 };
  }
  return { error: ERROR_UNAUTHORIZED, status: 401 };
}

let localShowcaseWarned = false;
let unsignedWebhookWarned = false;

const UNSIGNED_WEBHOOK_WARNING =
  "[Webhook] SENTRY_WEBHOOK_SECRET not set; skipping signature verification";

function warnLocalShowcaseOnce(): void {
  if (localShowcaseWarned) return;
  if (!localShowcase() || controlToken()) return;
  localShowcaseWarned = true;
  console.warn(
    "[Dan] DAN_LOCAL_SHOWCASE=1; control routes are open because DAN_CONTROL_TOKEN is unset",
  );
}

function warnUnsignedWebhooksOnce(): void {
  if (unsignedWebhookWarned) return;
  if (env("DAN_ALLOW_UNSIGNED_WEBHOOKS") !== "1") return;
  if (webhookSecret()) return;
  unsignedWebhookWarned = true;
  console.warn(UNSIGNED_WEBHOOK_WARNING);
}

function showcaseBlock(header: (name: string) => string | undefined): { error: string; status: 400 } | null {
  return showcaseMutationBlock(header("content-type"), header("origin"));
}

function guardControl(
  header: (name: string) => string | undefined,
  mutate: boolean,
): { error: string; status: 400 | 401 | 503 } | null {
  const host = showcaseHostBlock(header("host"));
  if (host) return host;
  if (mutate) {
    const showcase = showcaseBlock(header);
    if (showcase) return showcase;
  }
  return controlBlock(header("Authorization"));
}

function killSwitchJson(ks: KillSwitchRead): KillSwitchRead["state"] & {
  blocksWork: boolean;
  mode: KillSwitchRead["mode"];
  warning?: string;
} {
  return {
    ...ks.state,
    blocksWork: ks.blocksWork,
    mode: ks.mode,
    ...(ks.warning ? { warning: ks.warning } : {}),
  };
}

export function createApp(): Hono {
  const app = new Hono();

  app.get("/health", (c) => {
    const ks = readKillSwitch();
    const beats = listHeartbeats();
    const status = ks.blocksWork ? "held" : beats.staleCount > 0 ? "degraded" : "ok";
    return c.json({
      status,
      service: SERVICE_NAME,
      version: VERSION,
      brand: "San Diego AI Studio",
      uptime: process.uptime(),
      killSwitch: {
        active: ks.blocksWork,
        reason: ks.state.reason,
        mode: ks.mode,
      },
      heartbeats: {
        total: beats.beats.length,
        stale: beats.staleCount,
      },
      queue: actionQueue.stats(),
      note: "Control-plane skeleton. Statuses on the cutaway are an illustrative snapshot.",
    });
  });

  app.get("/os", (c) => {
    return c.json({
      name: "Dan: Intelligent OS control plane",
      brand: "San Diego AI Studio / Luc Face",
      properties: PROPERTIES,
      precedence: PROPERTIES.map((p) => p.id),
      layers: LAYERS,
      fleet: fleetSummary(),
      scope: {
        runs: [
          "Jobs live in memory and are lost on restart.",
          "Local diagnose, a person approves each proposal, optional Slack.",
          "Kill-switch and heartbeats are files on disk.",
        ],
        doesNotRun: ["Autofix does not run in production."],
      },
    });
  });

  app.get("/kill-switch", (c) => {
    const ks = readKillSwitch();
    if (ks.mode === "fail-closed" && ks.state.reason === "unreadable") {
      return c.json(errorFields(ERROR_COULD_NOT, killSwitchReadProblem()), 500);
    }
    return c.json(killSwitchJson(ks));
  });

  app.post("/kill-switch", async (c) => {
    const blocked = guardControl((name) => c.req.header(name), true);
    if (blocked) return c.json(errorFields(blocked.error, blocked.error), blocked.status);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch (err: unknown) {
      return c.json(errorFields(ERROR_INVALID_JSON, err), 400);
    }
    const parsed = z
      .object({
        active: z.boolean(),
        reason: z.string().optional(),
      })
      .safeParse(body);
    if (!parsed.success) {
      return c.json(errorFields(ERROR_INVALID_PAYLOAD, parsed.error), 400);
    }
    try {
      const ks = setKillSwitch({
        active: parsed.data.active,
        reason: parsed.data.reason ?? "",
        setBy: "human",
      });
      void notifyKillSwitch(ks.state);
      return c.json(killSwitchJson(ks));
    } catch (err: unknown) {
      const mapped = clientFailure(err);
      return c.json(errorFields(mapped.error, err), mapped.status);
    }
  });

  app.get("/heartbeats", (c) => {
    const folder = heartbeatFolderProblem();
    if (folder) return c.json(errorFields(ERROR_COULD_NOT, folder), 500);
    const listed = listHeartbeats();
    return c.json({
      staleCount: listed.staleCount,
      beats: listed.beats,
    });
  });

  app.post("/heartbeats", async (c) => {
    const blocked = guardControl((name) => c.req.header(name), true);
    if (blocked) return c.json(errorFields(blocked.error, blocked.error), blocked.status);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch (err: unknown) {
      return c.json(errorFields(ERROR_INVALID_JSON, err), 400);
    }
    const parsed = HeartbeatSchema.omit({ at: true }).safeParse(body);
    if (!parsed.success) {
      return c.json(errorFields(ERROR_INVALID_PAYLOAD, parsed.error), 400);
    }
    const beat = writeHeartbeat(parsed.data.name, parsed.data.cadenceSeconds);
    return c.json(beat);
  });

  app.route("/webhook", sentryWebhook);

  app.post("/trigger", async (c) => {
    const blocked = guardControl((name) => c.req.header(name), true);
    if (blocked) return c.json(errorFields(blocked.error, blocked.error), blocked.status);
    const url = new URL(c.req.url);
    url.pathname = "/webhook/trigger";
    const newReq = new Request(url.toString(), {
      method: "POST",
      headers: c.req.raw.headers,
      body: await c.req.text(),
    });
    return app.fetch(newReq);
  });

  app.post("/signals", async (c) => {
    const blocked = guardControl((name) => c.req.header(name), true);
    if (blocked) return c.json(errorFields(blocked.error, blocked.error), blocked.status);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch (err: unknown) {
      return c.json(errorFields(ERROR_INVALID_JSON, err), 400);
    }
    const parsed = SignalSchema.safeParse(body);
    if (!parsed.success) {
      const limit = signalLimitError(parsed.error);
      if (limit) return c.json(errorFields(limit, parsed.error), 400);
      return c.json(errorFields(ERROR_INVALID_PAYLOAD, parsed.error), 400);
    }
    try {
      const job = ingestSignal(parsed.data);
      return c.json({ status: "queued", job: serializeJob(job) });
    } catch (err: unknown) {
      return c.json(errorFields(ERROR_REQUEST_FAILED, err), 500);
    }
  });

  app.get("/jobs", (c) => {
    const blocked = guardControl((name) => c.req.header(name), false);
    if (blocked) return c.json(errorFields(blocked.error, blocked.error), blocked.status);
    const status = c.req.query("status");
    if (status && !JOB_STATUSES.has(status)) {
      return c.json(errorFields(ERROR_UNKNOWN_STATUS, ERROR_UNKNOWN_STATUS), 400);
    }
    const jobs = actionQueue.listJobs(status ? (status as JobStatusType) : undefined);
    return c.json({ jobs });
  });

  app.get("/jobs/:id", (c) => {
    const blocked = guardControl((name) => c.req.header(name), false);
    if (blocked) return c.json(errorFields(blocked.error, blocked.error), blocked.status);
    const job = actionQueue.getJob(c.req.param("id"));
    if (!job) {
      return c.json(errorFields(ERROR_JOB_NOT_FOUND, ERROR_JOB_NOT_FOUND), 404);
    }
    return c.json({ job: serializeJob(job) });
  });

  app.post("/jobs/:id/approve", async (c) => {
    const blocked = guardControl((name) => c.req.header(name), true);
    if (blocked) return c.json(errorFields(blocked.error, blocked.error), blocked.status);
    try {
      const job = decideJob(c.req.param("id"), "approved", "operator approved");
      return c.json({ job: serializeJob(job) });
    } catch (err: unknown) {
      const mapped = clientFailure(err);
      return c.json(errorFields(mapped.error, err), mapped.status);
    }
  });

  app.post("/jobs/:id/reject", async (c) => {
    const blocked = guardControl((name) => c.req.header(name), true);
    if (blocked) return c.json(errorFields(blocked.error, blocked.error), blocked.status);
    let reason = "operator rejected";
    try {
      const body = (await c.req.json()) as { reason?: unknown };
      if (typeof body.reason === "string" && body.reason.trim()) {
        reason = body.reason;
      }
    } catch {
      // empty body is fine
    }
    try {
      const job = decideJob(c.req.param("id"), "rejected", reason);
      return c.json({ job: serializeJob(job) });
    } catch (err: unknown) {
      const mapped = clientFailure(err);
      return c.json(errorFields(mapped.error, err), mapped.status);
    }
  });

  app.get("/", async (c) => {
    const file = Bun.file("public/index.html");
    if (await file.exists()) {
      return c.html(await file.text());
    }
    return c.text("Cutaway missing. Expected public/index.html", 404);
  });

  app.get("/status.json", async (c) => {
    const file = Bun.file("public/status.json");
    if (await file.exists()) {
      return c.json(await file.json());
    }
    return c.json({
      generatedAt: new Date().toISOString().slice(0, 10),
      note: "Illustrative snapshot of the cutaway.",
      nodes: {},
    });
  });

  app.onError((err, c) => {
    return c.json(errorFields(ERROR_REQUEST_FAILED, err), 500);
  });

  return app;
}

const app = createApp();
const port = serverPort();
const hostname = serverHost();

if (import.meta.main) {
  const refusal = startupRefusal();
  if (refusal) {
    console.error(refusal);
    process.exit(1);
  }
}

warnLocalShowcaseOnce();
warnUnsignedWebhooksOnce();

console.log(`[Dan] Intelligent OS control plane on :${port}`);
console.log(dataDirLogLine());
console.log(`[Dan] Cutaway:        http://localhost:${port}/`);
console.log(`[Dan] Health:         http://localhost:${port}/health`);
console.log(`[Dan] OS card:        http://localhost:${port}/os`);
console.log(`[Dan] Sentry intake:  POST http://localhost:${port}/webhook/sentry`);
console.log(`[Dan] Signal intake:  POST http://localhost:${port}/signals`);

export default {
  port,
  hostname,
  fetch: app.fetch,
};
