import { describe, it, expect, beforeEach } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { decideJob, ingestSignal } from "../src/pipeline";
import { readKillSwitch, setKillSwitch } from "../src/kill-switch";
import { isStale, listHeartbeats, writeHeartbeat } from "../src/heartbeats";
import { diagnose, formatAutofixPrompt, propose } from "../src/diagnose";
import { actionQueue } from "../src/queue";
import { JobStatus } from "../src/types";
import { runCli } from "../src/cli";
import { app, isolateDataDir, signPayload, validSentryPayload } from "./helpers";

describe("Health + OS card", () => {
  beforeEach(() => {
    isolateDataDir();
  });

  it("returns ok with kill-switch, heartbeats, and queue", async () => {
    const res = await app().request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      service: string;
      version: string;
      killSwitch: { mode: string; active: boolean };
      heartbeats: { stale: number };
    };
    expect(body.status).toBe("ok");
    expect(body.service).toBe("dan-the-automator");
    expect(body.version).toBe("0.2.0");
    expect(body.killSwitch.mode).toBe("fail-open");
    expect(body.killSwitch.active).toBe(false);
    expect(body.heartbeats.stale).toBe(0);
  });

  it("serves the public OS card", async () => {
    const res = await app().request("/os");
    const body = (await res.json()) as {
      properties: Array<{ id: string }>;
      layers: Array<{ name: string }>;
      honest: { notToday: string };
    };
    expect(res.status).toBe(200);
    expect(body.properties[0]?.id).toBe("truth-anchored");
    expect(body.layers).toHaveLength(9);
    expect(body.honest.notToday).toContain("No production autofix magic");
  });

  it("serves status.json", async () => {
    const res = await app().request("/status.json");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { note: string; nodes: Record<string, string> };
    expect(body.note.toLowerCase()).toContain("illustrative");
    expect(body.nodes["struvo"]).toBe("live");
  });
});

describe("Kill-switch contract", () => {
  beforeEach(() => {
    isolateDataDir();
  });

  it("fail-opens when the file is missing", () => {
    const ks = readKillSwitch();
    expect(ks.mode).toBe("fail-open");
    expect(ks.blocksWork).toBe(false);
  });

  it("fail-closes on corruption", () => {
    const dir = process.env["DAN_DATA_DIR"];
    if (!dir) throw new Error("expected isolated data dir");
    writeFileSync(join(dir, "kill-switch.json"), "{not-json");
    const ks = readKillSwitch();
    expect(ks.mode).toBe("fail-closed");
    expect(ks.blocksWork).toBe(true);
    expect(ks.state.reason).toBe("corruption");
  });

  it("arms and clears with a reason", () => {
    const on = setKillSwitch({ active: true, reason: "revenue week", setBy: "human" });
    expect(on.blocksWork).toBe(true);
    expect(on.mode).toBe("armed");
    const off = setKillSwitch({ active: false, reason: "", setBy: "human" });
    expect(off.blocksWork).toBe(false);
    expect(off.mode).toBe("clear");
  });

  it("refuses to arm without a reason", () => {
    expect(() => setKillSwitch({ active: true, reason: "  " })).toThrow("reason");
  });

  it("holds new jobs while armed", () => {
    setKillSwitch({ active: true, reason: "hold the fleet", setBy: "human" });
    const job = ingestSignal(
      { source: "operator", kind: "error", title: "boom", file: "src/a.ts" },
      { notify: false }
    );
    expect(job.status).toBe(JobStatus.HELD);
    expect(job.proposal).toBeUndefined();
  });
});

describe("Heartbeats", () => {
  beforeEach(() => {
    isolateDataDir();
  });

  it("marks a beat stale after 2x cadence", () => {
    const fresh = writeHeartbeat("meta-cron", 60);
    expect(isStale(fresh)).toBe(false);
    const old = writeHeartbeat("meta-cron", 60, new Date(Date.now() - 121_000));
    expect(isStale(old)).toBe(true);
    expect(listHeartbeats().staleCount).toBe(1);
  });

  it("degrades health when a beat is stale", async () => {
    writeHeartbeat("meta-cron", 60, new Date(Date.now() - 200_000));
    const res = await app().request("/health");
    const body = (await res.json()) as { status: string; heartbeats: { stale: number } };
    expect(body.status).toBe("degraded");
    expect(body.heartbeats.stale).toBe(1);
  });
});

describe("Diagnose + propose", () => {
  it("routes an error with a file to the autofix lane", () => {
    const d = diagnose({
      source: "sentry",
      kind: "error",
      title: "TypeError",
      file: "src/x.ts",
    });
    expect(d.recommendedAction).toBe("autofix-candidate");
    const p = propose(d, {
      source: "sentry",
      kind: "error",
      title: "TypeError",
      file: "src/x.ts",
    });
    expect(p.requiresHumanGate).toBe(true);
    expect(p.lane).toBe("autofix");
    expect(p.blastRadius).toBe("high");
  });

  it("holds revenue signals", () => {
    const d = diagnose({ source: "operator", kind: "revenue", title: "invoice" });
    expect(d.recommendedAction).toBe("hold");
    expect(d.property).toBe("revenue-protective");
  });

  it("builds a propose-only autofix prompt", () => {
    const prompt = formatAutofixPrompt({
      source: "sentry",
      kind: "error",
      title: "boom",
      file: "a.ts",
      line: 4,
    });
    expect(prompt).toContain("Do not apply it");
    expect(prompt).toContain("a.ts");
  });
});

describe("Pipeline + human gate", () => {
  beforeEach(() => {
    isolateDataDir();
  });

  it("ingests → proposes → approve → reported", () => {
    const job = ingestSignal(
      { source: "operator", kind: "ops", title: "restart lux", ref: "ops-1" },
      { notify: false }
    );
    expect(job.status).toBe(JobStatus.PROPOSED);
    expect(actionQueue.getJobByRef("ops-1")?.id).toBe(job.id);
    const decided = decideJob(job.id, "approved", "go");
    expect(decided.status).toBe(JobStatus.REPORTED);
    expect(decided.gate?.decision).toBe("approved");
  });

  it("rejects a proposal without executing anything", () => {
    const job = ingestSignal(
      { source: "operator", kind: "manual", title: "look at this" },
      { notify: false }
    );
    const decided = decideJob(job.id, "rejected", "not now");
    expect(decided.status).toBe(JobStatus.REJECTED);
  });

  it("filters jobs by status", () => {
    ingestSignal({ source: "a", kind: "manual", title: "one" }, { notify: false });
    const two = ingestSignal({ source: "a", kind: "manual", title: "two" }, { notify: false });
    actionQueue.fail(two.id, "nope");
    expect(actionQueue.getAllJobs(JobStatus.FAILED)).toHaveLength(1);
    expect(actionQueue.stats()[JobStatus.FAILED]).toBe(1);
  });
});

describe("HTTP intake", () => {
  const WEBHOOK_SECRET = "test-secret-key";

  beforeEach(() => {
    isolateDataDir();
    process.env["SENTRY_WEBHOOK_SECRET"] = WEBHOOK_SECRET;
  });

  it("accepts a signed Sentry payload as one intake adapter", async () => {
    const payload = JSON.stringify(validSentryPayload());
    const signature = await signPayload(payload, WEBHOOK_SECRET);
    const res = await app().request("/webhook/sentry", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "sentry-hook-signature": signature,
      },
      body: payload,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; issueId: string; jobStatus: string; lane: string };
    expect(body.status).toBe("queued");
    expect(body.issueId).toBe("12345");
    expect(body.jobStatus).toBe(JobStatus.PROPOSED);
    expect(body.lane).toBe("autofix");
  });

  it("rejects a bad Sentry signature", async () => {
    const res = await app().request("/webhook/sentry", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "sentry-hook-signature": "invalid-signature",
      },
      body: JSON.stringify(validSentryPayload()),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a missing Sentry signature when a secret is set", async () => {
    const res = await app().request("/webhook/sentry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validSentryPayload()),
    });
    expect(res.status).toBe(401);
  });

  it("rejects invalid JSON and missing fields", async () => {
    const badJson = await app().request("/webhook/sentry", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "sentry-hook-signature": await signPayload("not-json", WEBHOOK_SECRET),
      },
      body: "not-json",
    });
    expect(badJson.status).toBe(400);

    const payload = JSON.stringify({ action: "created" });
    const missing = await app().request("/webhook/sentry", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "sentry-hook-signature": await signPayload(payload, WEBHOOK_SECRET),
      },
      body: payload,
    });
    expect(missing.status).toBe(400);
  });

  it("ignores non-create Sentry actions", async () => {
    const payload = JSON.stringify({ ...validSentryPayload(), action: "resolved" });
    const res = await app().request("/webhook/sentry", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "sentry-hook-signature": await signPayload(payload, WEBHOOK_SECRET),
      },
      body: payload,
    });
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ignored");
  });

  it("accepts a manual trigger at /trigger and /webhook/trigger", async () => {
    delete process.env["SENTRY_WEBHOOK_SECRET"];
    const full = await app().request("/webhook/trigger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        issueId: "manual-001",
        title: "Test issue",
        seerAnalysis: "null check",
        file: "src/utils/helpers.ts",
        line: 42,
      }),
    });
    expect(full.status).toBe(200);
    expect(((await full.json()) as { status: string }).status).toBe("queued");

    const root = await app().request("/trigger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ issueId: "root-001", title: "Root trigger" }),
    });
    expect(root.status).toBe(200);

    const invalid = await app().request("/webhook/trigger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Missing nothing actually — title only is ok" }),
    });
    expect(invalid.status).toBe(200);
  });

  it("rejects a trigger without a title", async () => {
    const res = await app().request("/webhook/trigger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ issueId: "no-title" }),
    });
    expect(res.status).toBe(400);
  });

  it("gates control-plane writes when a token is set", async () => {
    process.env["DAN_CONTROL_TOKEN"] = "secret-token";
    const denied = await app().request("/signals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "operator", kind: "manual", title: "hi" }),
    });
    expect(denied.status).toBe(401);

    const ok = await app().request("/signals", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer secret-token",
      },
      body: JSON.stringify({ source: "operator", kind: "manual", title: "hi" }),
    });
    expect(ok.status).toBe(200);
  });

  it("approves and rejects over HTTP", async () => {
    const ingested = await app().request("/signals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "operator", kind: "manual", title: "gate me" }),
    });
    const created = (await ingested.json()) as { job: { id: string } };
    const approved = await app().request(`/jobs/${created.job.id}/approve`, { method: "POST" });
    expect(approved.status).toBe(200);
    expect(((await approved.json()) as { job: { status: string } }).job.status).toBe(JobStatus.REPORTED);

    const second = ingestSignal({ source: "operator", kind: "manual", title: "no" }, { notify: false });
    const rejected = await app().request(`/jobs/${second.id}/reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "not this week" }),
    });
    expect(((await rejected.json()) as { job: { status: string } }).job.status).toBe(JobStatus.REJECTED);
  });

  it("lists and fetches jobs", async () => {
    const job = ingestSignal({ source: "operator", kind: "manual", title: "listed" }, { notify: false });
    const list = await app().request("/jobs?status=proposed");
    const listed = (await list.json()) as { jobs: Array<{ id: string }> };
    expect(listed.jobs.some((j) => j.id === job.id)).toBe(true);

    const one = await app().request(`/jobs/${job.id}`);
    expect(one.status).toBe(200);
    const missing = await app().request("/jobs/nope");
    expect(missing.status).toBe(404);
  });
});

describe("CLI", () => {
  beforeEach(() => {
    isolateDataDir();
  });

  it("toggles the kill-switch and records a heartbeat", async () => {
    expect(await runCli(["ks", "on", "sprint freeze"])).toBe(0);
    expect(readKillSwitch().blocksWork).toBe(true);
    expect(await runCli(["ks", "off"])).toBe(0);
    expect(readKillSwitch().blocksWork).toBe(false);
    expect(await runCli(["heartbeat", "meta-cron", "--cadence", "60"])).toBe(0);
    expect(listHeartbeats().beats[0]?.name).toBe("meta-cron");
  });

  it("ingests and gates a job", async () => {
    expect(await runCli(["ingest", "--title", "cli signal", "--kind", "error", "--file", "x.ts"])).toBe(0);
    const job = actionQueue.getAllJobs()[0];
    expect(job?.status).toBe(JobStatus.PROPOSED);
    expect(job?.proposal?.lane).toBe("autofix");
    expect(await runCli(["approve", job?.id ?? ""])).toBe(0);
    expect(actionQueue.getJob(job?.id ?? "")?.status).toBe(JobStatus.REPORTED);
  });
});
