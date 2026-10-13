import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decideJob, ingestSignal } from "../src/pipeline";
import { readKillSwitch, setKillSwitch } from "../src/kill-switch";
import { isStale, listHeartbeats, writeHeartbeat } from "../src/heartbeats";
import { diagnose, formatAutofixPrompt, propose } from "../src/diagnose";
import { actionQueue } from "../src/queue";
import { JobStatus } from "../src/types";
import { runCli } from "../src/cli";
import { app, controlHeaders, isolateDataDir, restoreIsolatedEnv, signPayload, validSentryPayload } from "./helpers";

function expectErrorBody(text: string, error: string): void {
  // source: security review of 4e74e92
  const body: unknown = JSON.parse(text);
  if (typeof body !== "object" || body === null) throw new Error("error body is not an object");
  const record = body as Record<string, unknown>;
  expect(record["error"]).toBe(error);
  expect(record["id"]).toMatch(/^[0-9a-f]{8}$/);
  expect(Object.keys(record).sort()).toEqual(["error", "id"]);
}

describe("Health + OS card", () => {
  beforeEach(() => {
    delete process.env["SLACK_WEBHOOK_URL"];
    isolateDataDir();
  });

  afterEach(() => {
    restoreIsolatedEnv();
  });

  it("returns ok with kill-switch, heartbeats, and queue", async () => {
    // source: code review of the 2026-10-12 export
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
    expect(body.killSwitch.mode).toBe("clear");
    expect(body.killSwitch.active).toBe(false);
    expect(body.heartbeats.stale).toBe(0);
  });

  it("serves the public OS card", async () => {
    // source: second code review of the 2026-10-12 export
    const res = await app().request("/os");
    const body = (await res.json()) as {
      properties: Array<{ id: string }>;
      layers: Array<{ name: string }>;
      fleet: { rule: string };
      scope: { runs: string[]; doesNotRun: string[] };
      ethos?: string;
      honest?: { notToday: string };
    };
    expect(res.status).toBe(200);
    expect(body.properties[0]?.id).toBe("truth-anchored");
    expect(body.layers).toHaveLength(9);
    expect(body.ethos).toBeUndefined();
    // source: third code review of the 2026-10-12 export
    expect(body.honest).toBeUndefined();
    expect(body.scope.doesNotRun).toContain("Autofix does not run in production.");
    // source: simplification round, 2026-10-13
    expect(body.scope.runs).toContain("Jobs live in memory and are lost on restart.");
    expect(body.scope.runs).toContain("Local diagnose, a person approves each proposal, optional Slack.");
    expect(body.scope.runs).toContain("Kill-switch and heartbeats are files on disk.");
    expect(body.fleet.rule).toBe("Dormant agents start on a matching keyword.");
    const card = JSON.stringify(body);
    expect(card).toContain("Caps time on system work.");
    expect(card).toContain("Fires on a set date or measured threshold.");
    expect(card).toContain("An empty response is an error.");
    expect(card).toContain("A critic reviews each change.");
    expect(card).toContain("Append-only records.");
    expect(card).toContain("A claim that contradicts the record is removed.");
    expect(card).toContain("Fallback spend stays inside a set budget.");
    expect(card).toContain("Every agent has a name and wake rules.");
    expect(card).toContain("It can pause work in every other layer.");
    expect(card.includes("The riverbed has to stay up.")).toBe(false);
    expect(card.includes("The flywheel under the floor.")).toBe(false);
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
    delete process.env["SLACK_WEBHOOK_URL"];
    isolateDataDir();
  });

  afterEach(() => {
    restoreIsolatedEnv();
  });

  it("arms when the state file is missing", () => {
    // source: code review of the 2026-10-12 export
    const data = process.env["DAN_DATA_DIR"];
    if (!data) throw new Error("expected isolated data dir");
    unlinkSync(join(data, "kill-switch.json"));
    const ks = readKillSwitch();
    expect(ks.mode).toBe("fail-closed");
    expect(ks.blocksWork).toBe(true);
    expect(ks.state.reason).toBe("state file missing");
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

  it("moves held jobs to the proposal step in ingest order when the switch is turned off", async () => {
    // source: code review of the 2026-10-12 export
    // source: simplification round, 2026-10-13
    setKillSwitch({ active: true, reason: "hold the fleet", setBy: "human" });
    const first = ingestSignal(
      { source: "operator", kind: "manual", title: "first held", ref: "held-1" },
      { notify: false },
    );
    const second = ingestSignal(
      { source: "operator", kind: "manual", title: "second held", ref: "held-2" },
      { notify: false },
    );
    expect(first.status).toBe(JobStatus.HELD);
    expect(second.status).toBe(JobStatus.HELD);
    const repeat = ingestSignal(
      { source: "operator", kind: "manual", title: "first held again", ref: "held-1" },
      { notify: false },
    );
    expect(repeat.id).toBe(first.id);
    expect(actionQueue.stats()["held"]).toBe(2);

    const cleared = await app().request("/kill-switch", {
      method: "POST",
      headers: controlHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ active: false, reason: "" }),
    });
    expect(cleared.status).toBe(200);
    expect(first.status).toBe(JobStatus.PROPOSED);
    expect(second.status).toBe(JobStatus.PROPOSED);
    expect(first.proposal).toBeDefined();
    expect(second.proposal).toBeDefined();
    expect(first.error).toBeUndefined();
    expect(second.updatedAt.getTime()).toBeGreaterThan(first.updatedAt.getTime());
  });
});

describe("Heartbeats", () => {
  beforeEach(() => {
    delete process.env["SLACK_WEBHOOK_URL"];
    isolateDataDir();
  });

  afterEach(() => {
    restoreIsolatedEnv();
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
  beforeEach(() => {
    delete process.env["SLACK_WEBHOOK_URL"];
  });

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
    // source: second code review of the 2026-10-12 export
    const prompt = formatAutofixPrompt({
      source: "sentry",
      kind: "error",
      title: "boom",
      file: "a.ts",
      line: 4,
    });
    expect(prompt.endsWith("Queued for review.")).toBe(true);
    expect(prompt).toContain("a.ts");
  });
});

describe("Pipeline + human gate", () => {
  beforeEach(() => {
    delete process.env["SLACK_WEBHOOK_URL"];
    isolateDataDir();
  });

  afterEach(() => {
    restoreIsolatedEnv();
  });

  it("ingests → proposes → approve → reported", () => {
    const job = ingestSignal(
      { source: "operator", kind: "ops", title: "restart a local machine", ref: "ops-1" },
      { notify: false }
    );
    expect(job.status).toBe(JobStatus.PROPOSED);
    expect(actionQueue.getJobByRef("ops-1")?.id).toBe(job.id);
    const decided = decideJob(job.id, "approved", "go");
    expect(decided.status).toBe(JobStatus.REPORTED);
    expect(decided.gate?.decision).toBe("approved");
  });

  it("does not change a decided job", () => {
    // source: code review of the 2026-10-12 export
    const job = ingestSignal(
      { source: "operator", kind: "manual", title: "decide once" },
      { notify: false },
    );
    const rejected = decideJob(job.id, "rejected", "no");
    expect(rejected.status).toBe(JobStatus.REJECTED);
    expect(() => decideJob(job.id, "approved", "later")).toThrow(/cannot change state again/);
    expect(actionQueue.getJob(job.id)?.status).toBe(JobStatus.REJECTED);
    expect(actionQueue.getJob(job.id)?.gate?.decision).toBe("rejected");

    const approved = ingestSignal(
      { source: "operator", kind: "manual", title: "approve once" },
      { notify: false },
    );
    expect(decideJob(approved.id, "approved", "go").status).toBe(JobStatus.REPORTED);
    expect(() => decideJob(approved.id, "rejected", "undo")).toThrow(/cannot change state again/);
    expect(actionQueue.getJob(approved.id)?.status).toBe(JobStatus.REPORTED);
  });

  it("dedupes a repeated signal with the same source and ref", () => {
    // source: code review of the 2026-10-12 export
    const first = ingestSignal(
      { source: "sentry", kind: "error", title: "once", ref: "iss-1", file: "a.ts" },
      { notify: false },
    );
    const second = ingestSignal(
      { source: "sentry", kind: "error", title: "again", ref: "iss-1", file: "a.ts" },
      { notify: false },
    );
    expect(second.id).toBe(first.id);
    expect(actionQueue.getAllJobs()).toHaveLength(1);
    const other = ingestSignal(
      { source: "operator", kind: "error", title: "other source", ref: "iss-1", file: "a.ts" },
      { notify: false },
    );
    expect(other.id).not.toBe(first.id);
    expect(actionQueue.getAllJobs()).toHaveLength(2);
  });

  it("replaces newlines and control characters in signal logs", () => {
    // source: code review of the 2026-10-12 export
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map((part) => String(part)).join(" "));
    };
    try {
      const job = ingestSignal(
        { source: "op\nerator", kind: "manual", title: "bad\rtitle\u0001here" },
        { notify: false },
      );
      expect(job.signal.title).toBe("bad\rtitle\u0001here");
      expect(job.signal.source).toBe("op\nerator");
    } finally {
      console.log = original;
    }
    const logged = lines.find((line) => line.includes("ingested from"));
    expect(logged).toBeDefined();
    expect(logged?.includes("\n")).toBe(false);
    expect(logged?.includes("\r")).toBe(false);
    expect(logged?.includes("\u0001")).toBe(false);
    expect(logged).toContain("bad title here");
    expect(logged).toContain("op erator");
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
    delete process.env["SLACK_WEBHOOK_URL"];
    isolateDataDir();
    process.env["SENTRY_WEBHOOK_SECRET"] = WEBHOOK_SECRET;
  });

  afterEach(() => {
    restoreIsolatedEnv();
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

  it("accepts a signed Sentry issue whose actor id is a string and whose permalink is null", async () => {
    // source: code review of the 2026-10-12 export
    const payload = JSON.stringify({
      action: "created",
      installation: { uuid: "ignored-installation" },
      data: {
        issue: {
          id: "sentry-null-permalink",
          title: "Null permalink",
          permalink: null,
          status: "unresolved",
          metadata: { value: "details", filename: "src/a.ts" },
        },
      },
      actor: { type: "application", id: "sentry", name: "Sentry" },
    });
    const headers = {
      "Content-Type": "application/json",
      "sentry-hook-signature": await signPayload(payload, WEBHOOK_SECRET),
    };
    const res = await app().request("/webhook/sentry", { method: "POST", headers, body: payload });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; jobId: string; jobStatus: string };
    expect(body.status).toBe("queued");
    expect(body.jobStatus).toBe(JobStatus.PROPOSED);
    expect(actionQueue.getAllJobs()).toHaveLength(1);

    const again = await app().request("/webhook/sentry", { method: "POST", headers, body: payload });
    expect(again.status).toBe(200);
    const repeated = (await again.json()) as { jobId: string };
    expect(repeated.jobId).toBe(body.jobId);
    expect(actionQueue.getAllJobs()).toHaveLength(1);

    const absentBody = JSON.stringify({
      action: "triggered",
      data: {
        issue: {
          id: "sentry-absent-permalink",
          title: "Permalink absent",
          metadata: { value: "details", filename: "src/b.ts" },
        },
      },
      actor: { type: "application", id: "sentry", name: "Sentry" },
    });
    const absent = await app().request("/webhook/sentry", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "sentry-hook-signature": await signPayload(absentBody, WEBHOOK_SECRET),
      },
      body: absentBody,
    });
    expect(absent.status).toBe(200);
    expect(actionQueue.getAllJobs()).toHaveLength(2);
  });

  it("rejects a title over 200 characters and a body over 8000", async () => {
    // source: code review of the 2026-10-12 export
    // source: security review of 4e74e92
    const tooLongTitle = await app().request("/signals", {
      method: "POST",
      headers: controlHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ source: "operator", kind: "manual", title: "t".repeat(201) }),
    });
    expect(tooLongTitle.status).toBe(400);
    expectErrorBody(await tooLongTitle.text(), "title must be at most 200 characters");

    const tooLongBody = await app().request("/signals", {
      method: "POST",
      headers: controlHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ source: "operator", kind: "manual", title: "ok", body: "b".repeat(8001) }),
    });
    expect(tooLongBody.status).toBe(400);
    expectErrorBody(await tooLongBody.text(), "body must be at most 8000 characters");

    const accepted = await app().request("/signals", {
      method: "POST",
      headers: controlHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        source: "operator",
        kind: "manual",
        title: "t".repeat(200),
        body: "b".repeat(8000),
      }),
    });
    expect(accepted.status).toBe(200);
    expect(actionQueue.getAllJobs()).toHaveLength(1);

    const sentryTitle = JSON.stringify({
      action: "created",
      data: { issue: { id: "long-title", title: "t".repeat(201), permalink: null } },
      actor: { type: "application", id: "sentry", name: "Sentry" },
    });
    const sentryRes = await app().request("/webhook/sentry", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "sentry-hook-signature": await signPayload(sentryTitle, WEBHOOK_SECRET),
      },
      body: sentryTitle,
    });
    expect(sentryRes.status).toBe(400);
    expectErrorBody(await sentryRes.text(), "title must be at most 200 characters");
    expect(actionQueue.getAllJobs()).toHaveLength(1);
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

  it("rejects the Sentry webhook when the secret is unset", async () => {
    // source: unset SENTRY_WEBHOOK_SECRET fails closed with 503 and ingests nothing
    // source: security review of 4e74e92
    delete process.env["SENTRY_WEBHOOK_SECRET"];
    delete process.env["DAN_ALLOW_UNSIGNED_WEBHOOKS"];
    const before = actionQueue.getAllJobs().length;
    const res = await app().request("/webhook/sentry", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "sentry-hook-signature": "not-a-signature",
      },
      body: JSON.stringify(validSentryPayload()),
    });
    expect(res.status).toBe(503);
    expectErrorBody(await res.text(), "webhook secret not configured");
    expect(actionQueue.getAllJobs().length).toBe(before);
  });

  it("treats an empty Sentry webhook secret as unset", async () => {
    // source: simplification round, 2026-10-13
    for (const value of ["", "   "]) {
      process.env["SENTRY_WEBHOOK_SECRET"] = value;
      delete process.env["DAN_ALLOW_UNSIGNED_WEBHOOKS"];
      const closed = await app().request("/webhook/sentry", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "sentry-hook-signature": "not-a-signature",
        },
        body: JSON.stringify(validSentryPayload()),
      });
      expect(closed.status).toBe(503);
      expectErrorBody(await closed.text(), "webhook secret not configured");
    }
    process.env["SENTRY_WEBHOOK_SECRET"] = "";
    process.env["DAN_ALLOW_UNSIGNED_WEBHOOKS"] = "1";
    const open = await app().request("/webhook/sentry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validSentryPayload()),
    });
    expect(open.status).toBe(200);
  });

  it("does not treat other allow-flag values as permission to skip the webhook secret", async () => {
    // source: DAN_ALLOW_UNSIGNED_WEBHOOKS must be exactly "1" or the unset secret stays closed
    // source: security review of 4e74e92
    delete process.env["SENTRY_WEBHOOK_SECRET"];
    process.env["DAN_ALLOW_UNSIGNED_WEBHOOKS"] = "true";
    const res = await app().request("/webhook/sentry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validSentryPayload()),
    });
    expect(res.status).toBe(503);
    expectErrorBody(await res.text(), "webhook secret not configured");
    expect(actionQueue.getAllJobs()).toHaveLength(0);
  });

  it("accepts an unsigned Sentry webhook when DAN_ALLOW_UNSIGNED_WEBHOOKS is 1", async () => {
    // source: DAN_ALLOW_UNSIGNED_WEBHOOKS=1 accepts an unsigned webhook and logs one warning
    // source: third code review of the 2026-10-12 export
    // The warning is logged once when the process starts, not on each request.
    delete process.env["SENTRY_WEBHOOK_SECRET"];
    process.env["DAN_ALLOW_UNSIGNED_WEBHOOKS"] = "1";
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown, ...rest: unknown[]) => {
      warnings.push([message, ...rest].map((part) => String(part)).join(" "));
    };
    try {
      const res = await app().request("/webhook/sentry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validSentryPayload()),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { status: string }).status).toBe("queued");
      expect(warnings).toEqual([]);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("keeps a set secret required when unsigned webhooks are also allowed", async () => {
    // source: a missing or wrong signature with a secret set stays a 401
    process.env["DAN_ALLOW_UNSIGNED_WEBHOOKS"] = "1";
    const res = await app().request("/webhook/sentry", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "sentry-hook-signature": "invalid-signature",
      },
      body: JSON.stringify(validSentryPayload()),
    });
    expect(res.status).toBe(401);
    expect(actionQueue.getAllJobs()).toHaveLength(0);
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
    // source: second code review of the 2026-10-12 export
    delete process.env["SENTRY_WEBHOOK_SECRET"];
    const full = await app().request("/webhook/trigger", {
      method: "POST",
      headers: controlHeaders({ "Content-Type": "application/json" }),
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
      headers: controlHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ issueId: "root-001", title: "Root trigger" }),
    });
    expect(root.status).toBe(200);

    const invalid = await app().request("/webhook/trigger", {
      method: "POST",
      headers: controlHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ title: "Missing nothing actually: title only is ok" }),
    });
    expect(invalid.status).toBe(200);
  });

  it("rejects a trigger without a title", async () => {
    const res = await app().request("/webhook/trigger", {
      method: "POST",
      headers: controlHeaders({ "Content-Type": "application/json" }),
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
      headers: controlHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ source: "operator", kind: "manual", title: "gate me" }),
    });
    const created = (await ingested.json()) as { job: { id: string } };
    const approved = await app().request(`/jobs/${created.job.id}/approve`, {
      method: "POST",
      headers: controlHeaders(),
    });
    expect(approved.status).toBe(200);
    expect(((await approved.json()) as { job: { status: string } }).job.status).toBe(JobStatus.REPORTED);

    const second = ingestSignal({ source: "operator", kind: "manual", title: "no" }, { notify: false });
    const rejected = await app().request(`/jobs/${second.id}/reject`, {
      method: "POST",
      headers: controlHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ reason: "not this week" }),
    });
    expect(((await rejected.json()) as { job: { status: string } }).job.status).toBe(JobStatus.REJECTED);
  });

  it("lists and fetches jobs", async () => {
    const job = ingestSignal({ source: "operator", kind: "manual", title: "listed" }, { notify: false });
    const list = await app().request("/jobs?status=proposed", { headers: controlHeaders() });
    const listed = (await list.json()) as { jobs: Array<{ id: string }> };
    expect(listed.jobs.some((j) => j.id === job.id)).toBe(true);

    const one = await app().request(`/jobs/${job.id}`, { headers: controlHeaders() });
    expect(one.status).toBe(200);
    const missing = await app().request("/jobs/nope", { headers: controlHeaders() });
    expect(missing.status).toBe(404);
  });
});

describe("CLI", () => {
  let savedPort: string | undefined;

  beforeEach(() => {
    delete process.env["SLACK_WEBHOOK_URL"];
    savedPort = process.env["PORT"];
    isolateDataDir();
  });

  afterEach(() => {
    if (savedPort === undefined) delete process.env["PORT"];
    else process.env["PORT"] = savedPort;
    restoreIsolatedEnv();
  });

  it("toggles the kill-switch and records a heartbeat", async () => {
    expect(await runCli(["ks", "on", "sprint freeze"])).toBe(0);
    expect(readKillSwitch().blocksWork).toBe(true);
    expect(await runCli(["ks", "off"])).toBe(0);
    expect(readKillSwitch().blocksWork).toBe(false);
    expect(await runCli(["heartbeat", "meta-cron", "--cadence", "60"])).toBe(0);
    expect(listHeartbeats().beats[0]?.name).toBe("meta-cron");
  });

  it("ingests and gates a job on the server", async () => {
    // source: simplification round, 2026-10-13
    const server = startLocalServer();
    try {
      const ingested = await captureCli(() =>
        runCli(["ingest", "--title", "cli signal", "--kind", "error", "--file", "x.ts"]),
      );
      expect(ingested.code, ingested.stderr).toBe(0);
      const job = actionQueue.getAllJobs()[0];
      expect(job?.status).toBe(JobStatus.PROPOSED);
      expect(job?.proposal?.lane).toBe("autofix");
      expect(ingested.stdout).toContain(job?.id ?? "missing");
      expect(await runCli(["approve", job?.id ?? ""])).toBe(0);
      expect(actionQueue.getJob(job?.id ?? "")?.status).toBe(JobStatus.REPORTED);
      const denied = await captureCli(() => runCli(["reject", job?.id ?? "", "--reason", "too late"]));
      expect(denied.code).toBe(1);
      expect(actionQueue.getJob(job?.id ?? "")?.status).toBe(JobStatus.REPORTED);
    } finally {
      stopLocalServer(server);
    }
  });

  it("tells you to start bun dev when no server is answering", async () => {
    // source: simplification round, 2026-10-13
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("x") });
    const port = probe.port;
    probe.stop(true);
    process.env["PORT"] = String(port);
    for (const args of [
      ["ingest", "--title", "offline"],
      ["approve", "job_missing"],
      ["reject", "job_missing"],
    ]) {
      const captured = await captureCli(() => runCli(args));
      expect(captured.code, args.join(" ")).toBe(1);
      expect(captured.stderr).toBe("No server is answering on 127.0.0.1. Start it with bun dev.");
    }
  });

  it("lets another process ingest and approve the server's jobs", async () => {
    // source: simplification round, 2026-10-13
    const dir = dataDirOrThrow();
    const server = startLocalServer();
    try {
      const ingested = await spawnDan(dir, ["ingest", "--title", "from a second process", "--kind", "ops", "--ref", "cli-1"]);
      expect(ingested.code, `${ingested.stderr}\n${ingested.stdout}`).toBe(0);
      const job = actionQueue.getAllJobs().find((item) => item.signal.ref === "cli-1");
      expect(job?.status).toBe(JobStatus.PROPOSED);
      expect(ingested.stdout).toContain(job?.id ?? "missing");
      const again = await spawnDan(dir, ["ingest", "--title", "from a second process", "--kind", "ops", "--ref", "cli-1"]);
      expect(again.code, again.stderr).toBe(0);
      expect(actionQueue.getAllJobs().filter((item) => item.signal.ref === "cli-1")).toHaveLength(1);
      const approved = await spawnDan(dir, ["approve", job?.id ?? ""]);
      expect(approved.code, `${approved.stderr}\n${approved.stdout}`).toBe(0);
      expect(actionQueue.getJob(job?.id ?? "")?.status).toBe(JobStatus.REPORTED);
      expect(existsSync(join(dir, "jobs.json"))).toBe(false);
    } finally {
      stopLocalServer(server);
    }
  });

  it("loses jobs when the server process stops", async () => {
    // source: simplification round, 2026-10-13
    const dir = dataDirOrThrow();
    const token = process.env["DAN_CONTROL_TOKEN"] ?? "";
    const firstPort = reservePort();
    const first = startDanProcess(dir, firstPort, token);
    try {
      expect(await waitForHealth(first, firstPort)).toBe(true);
      process.env["PORT"] = String(firstPort);
      const ingested = await spawnDan(dir, ["ingest", "--title", "gone on restart", "--ref", "restart-1"]);
      expect(ingested.code, `${ingested.stderr}\n${ingested.stdout}`).toBe(0);
      const listed = await fetch(`http://127.0.0.1:${firstPort}/jobs`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(listed.status).toBe(200);
      const body = (await listed.json()) as { jobs: unknown[] };
      expect(body.jobs).toHaveLength(1);
      expect(existsSync(join(dir, "jobs.json"))).toBe(false);
    } finally {
      first.kill();
      await first.exited;
    }
    const secondPort = reservePort();
    const second = startDanProcess(dir, secondPort, token);
    try {
      expect(await waitForHealth(second, secondPort)).toBe(true);
      const listed = await fetch(`http://127.0.0.1:${secondPort}/jobs`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(listed.status).toBe(200);
      const body = (await listed.json()) as { jobs: unknown[] };
      expect(body.jobs).toHaveLength(0);
    } finally {
      second.kill();
      await second.exited;
    }
  });
});

function dataDirOrThrow(): string {
  const dir = process.env["DAN_DATA_DIR"];
  if (!dir) throw new Error("expected isolated data dir");
  return dir;
}

async function spawnDan(dir: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "USER", "PORT", "DAN_CONTROL_TOKEN"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env["DAN_DATA_DIR"] = dir;
  const result = Bun.spawn(["bun", "--no-env-file", "run", "src/cli.ts", ...args], {
    cwd: join(import.meta.dir, ".."),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(result.stdout).text();
  const stderr = await new Response(result.stderr).text();
  return {
    code: (await result.exited) ?? 1,
    stdout,
    stderr,
  };
}

function startLocalServer(): ReturnType<typeof Bun.serve> {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: app().fetch,
  });
  process.env["PORT"] = String(server.port);
  return server;
}

function stopLocalServer(server: ReturnType<typeof Bun.serve>): void {
  server.stop(true);
}

async function captureCli(run: () => Promise<number>): Promise<{ code: number; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...args: unknown[]) => {
    out.push(args.map((part) => String(part)).join(" "));
  };
  console.error = (...args: unknown[]) => {
    err.push(args.map((part) => String(part)).join(" "));
  };
  try {
    const code = await run();
    return { code, stdout: out.join("\n"), stderr: err.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}

function reservePort(): number {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
  const port = probe.port;
  probe.stop(true);
  if (port === undefined) throw new Error("could not reserve a port");
  return port;
}

function startDanProcess(dir: string, port: number, token: string): Bun.Subprocess {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "USER"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env["DAN_DATA_DIR"] = dir;
  env["PORT"] = String(port);
  env["DAN_CONTROL_TOKEN"] = token;
  const secret = process.env["SENTRY_WEBHOOK_SECRET"];
  if (secret !== undefined) env["SENTRY_WEBHOOK_SECRET"] = secret;
  const proc = Bun.spawn(["bun", "--no-env-file", "src/index.ts"], {
    cwd: join(import.meta.dir, ".."),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  void new Response(proc.stdout).text();
  void new Response(proc.stderr).text();
  return proc;
}

async function waitForHealth(proc: Bun.Subprocess, port: number): Promise<boolean> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) return false;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.status === 200) return true;
    } catch {
      // the process is not listening yet
    }
    await Bun.sleep(30);
  }
  return false;
}

describe("isolated env restore", () => {
  beforeEach(() => {
    delete process.env["SLACK_WEBHOOK_URL"];
  });

  afterEach(() => {
    restoreIsolatedEnv();
  });

  it("sets a marker the helper must not leave behind", () => {
    // source: code review of the 2026-10-12 export
    isolateDataDir();
    process.env["DAN_ALLOW_UNSIGNED_WEBHOOKS"] = "marker-should-not-leak";
  });

  it("restores environment variables the helper set", () => {
    // source: code review of the 2026-10-12 export
    expect(process.env["DAN_ALLOW_UNSIGNED_WEBHOOKS"]).not.toBe("marker-should-not-leak");
  });
});
