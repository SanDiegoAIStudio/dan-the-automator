import { Hono } from "hono";
import { authorizeControl } from "./auth";
import { SERVICE_NAME, VERSION, serverPort } from "./config";
import { fleetSummary } from "./fleet";
import { listHeartbeats, writeHeartbeat } from "./heartbeats";
import { sentryWebhook } from "./intake/sentry";
import { readKillSwitch, setKillSwitch } from "./kill-switch";
import { notifyKillSwitch } from "./notify/slack";
import { decideJob, ingestSignal } from "./pipeline";
import { LAYERS, PROPERTIES } from "./properties";
import { actionQueue } from "./queue";
import { z } from "zod";
import { HeartbeatSchema, JobStatus, SignalSchema, serializeJob, type JobStatusType } from "./types";

const JOB_STATUSES = new Set<string>(Object.values(JobStatus));

function unauthorized() {
  return { error: "Unauthorized" } as const;
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
      note: "Control-plane skeleton. Statuses on the cutaway are illustrative, not a live telemetry feed.",
    });
  });

  app.get("/os", (c) => {
    return c.json({
      name: "Dan — Intelligent OS control plane",
      brand: "San Diego AI Studio / Luc Face",
      ethos: "Casual Building for Serious Leverage",
      properties: PROPERTIES,
      precedence: PROPERTIES.map((p) => p.id),
      layers: LAYERS,
      fleet: fleetSummary(),
      honest: {
        today: "In-memory queue, local diagnose, human gate, optional Slack. Kill-switch and heartbeats are real files.",
        notToday: "No production autofix magic. Claude/GitHub PR write-back is a lane, not the product.",
      },
    });
  });

  app.get("/kill-switch", (c) => {
    const ks = readKillSwitch();
    return c.json({
      ...ks.state,
      blocksWork: ks.blocksWork,
      mode: ks.mode,
    });
  });

  app.post("/kill-switch", async (c) => {
    if (!authorizeControl(c.req.header("Authorization"))) {
      return c.json(unauthorized(), 401);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const parsed = z
      .object({
        active: z.boolean(),
        reason: z.string().optional(),
      })
      .safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid payload", details: parsed.error.flatten() }, 400);
    }
    try {
      const ks = setKillSwitch({
        active: parsed.data.active,
        reason: parsed.data.reason ?? "",
        setBy: "human",
      });
      void notifyKillSwitch(ks.state);
      return c.json({ ...ks.state, blocksWork: ks.blocksWork, mode: ks.mode });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 400);
    }
  });

  app.get("/heartbeats", (c) => {
    return c.json(listHeartbeats());
  });

  app.post("/heartbeats", async (c) => {
    if (!authorizeControl(c.req.header("Authorization"))) {
      return c.json(unauthorized(), 401);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const parsed = HeartbeatSchema.omit({ at: true }).safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid payload", details: parsed.error.flatten() }, 400);
    }
    const beat = writeHeartbeat(parsed.data.name, parsed.data.cadenceSeconds);
    return c.json(beat);
  });

  app.route("/webhook", sentryWebhook);

  app.post("/trigger", async (c) => {
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
    if (!authorizeControl(c.req.header("Authorization"))) {
      return c.json(unauthorized(), 401);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const parsed = SignalSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid payload", details: parsed.error.flatten() }, 400);
    }
    const job = ingestSignal(parsed.data);
    return c.json({ status: "queued", job: serializeJob(job) });
  });

  app.get("/jobs", (c) => {
    const status = c.req.query("status");
    if (status && !JOB_STATUSES.has(status)) {
      return c.json({ error: "Unknown status" }, 400);
    }
    const jobs = status
      ? actionQueue.getAllJobs(status as JobStatusType)
      : actionQueue.getAllJobs();
    return c.json({ jobs: jobs.map(serializeJob) });
  });

  app.get("/jobs/:id", (c) => {
    const job = actionQueue.getJob(c.req.param("id"));
    if (!job) {
      return c.json({ error: "Job not found" }, 404);
    }
    return c.json({ job: serializeJob(job) });
  });

  app.post("/jobs/:id/approve", async (c) => {
    if (!authorizeControl(c.req.header("Authorization"))) {
      return c.json(unauthorized(), 401);
    }
    try {
      const job = decideJob(c.req.param("id"), "approved", "operator approved");
      return c.json({ job: serializeJob(job) });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const code = message.includes("not found") ? 404 : 400;
      return c.json({ error: message }, code);
    }
  });

  app.post("/jobs/:id/reject", async (c) => {
    if (!authorizeControl(c.req.header("Authorization"))) {
      return c.json(unauthorized(), 401);
    }
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
      const message = err instanceof Error ? err.message : String(err);
      const code = message.includes("not found") ? 404 : 400;
      return c.json({ error: message }, code);
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
      note: "Illustrative snapshot, not a live telemetry feed.",
      nodes: {},
    });
  });

  return app;
}

const app = createApp();
const port = serverPort();

console.log(`[Dan] Intelligent OS control plane on :${port}`);
console.log(`[Dan] Cutaway:        http://localhost:${port}/`);
console.log(`[Dan] Health:         http://localhost:${port}/health`);
console.log(`[Dan] OS card:        http://localhost:${port}/os`);
console.log(`[Dan] Sentry intake:  POST http://localhost:${port}/webhook/sentry`);
console.log(`[Dan] Signal intake:  POST http://localhost:${port}/signals`);

export default {
  port,
  fetch: app.fetch,
};
