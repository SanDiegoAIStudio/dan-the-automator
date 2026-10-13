import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serverPort, startupRefusal, UNSIGNED_BIND_REFUSAL } from "../src/config";
import { listHeartbeats, writeHeartbeat } from "../src/heartbeats";
import { setKillSwitch } from "../src/kill-switch";
import { notifyJobUpdate, notifySignalIngested } from "../src/notify/slack";
import { decideJob, ingestSignal } from "../src/pipeline";
import { actionQueue } from "../src/queue";
import { JobStatus, type ActionJob } from "../src/types";
import { app, controlHeaders, isolateDataDir, restoreIsolatedEnv } from "./helpers";

const ROOT = join(import.meta.dir, "..");

function expectErrorBody(text: string, error: string): void {
  // source: security review of 4e74e92
  const body: unknown = JSON.parse(text);
  if (typeof body !== "object" || body === null) throw new Error("error body is not an object");
  const record = body as Record<string, unknown>;
  expect(record["error"]).toBe(error);
  expect(record["id"]).toMatch(/^[0-9a-f]{8}$/);
  expect(Object.keys(record).sort()).toEqual(["error", "id"]);
}
const runningAsRoot = typeof process.getuid === "function" && process.getuid() === 0;
const UNSIGNED_WARNING = "[Webhook] SENTRY_WEBHOOK_SECRET not set; skipping signature verification";

function dataDirOrThrow(): string {
  const dir = process.env["DAN_DATA_DIR"];
  if (!dir) throw new Error("expected isolated data dir");
  return dir;
}

function childEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "USER"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) env[key] = value;
  return env;
}

describe("open job dedupe", () => {
  beforeEach(() => {
    delete process.env["SLACK_WEBHOOK_URL"];
    isolateDataDir();
  });

  afterEach(() => {
    restoreIsolatedEnv();
  });

  it("queues a new job when the earlier one was rejected, reported, or failed", () => {
    // source: third code review of the 2026-10-12 export
    const rejected = ingestSignal(
      { source: "sentry", kind: "error", title: "once", ref: "again", file: "a.ts" },
      { notify: false },
    );
    decideJob(rejected.id, "rejected", "no");
    const rejectedAgain = ingestSignal(
      { source: "sentry", kind: "error", title: "twice", ref: "again", file: "a.ts" },
      { notify: false },
    );
    expect(rejectedAgain.id).not.toBe(rejected.id);

    const reported = ingestSignal(
      { source: "operator", kind: "manual", title: "report", ref: "done-1" },
      { notify: false },
    );
    decideJob(reported.id, "approved", "go");
    const reportedAgain = ingestSignal(
      { source: "operator", kind: "manual", title: "report again", ref: "done-1" },
      { notify: false },
    );
    expect(reportedAgain.id).not.toBe(reported.id);

    const failed = ingestSignal(
      { source: "operator", kind: "ops", title: "fail", ref: "fail-1" },
      { notify: false },
    );
    actionQueue.fail(failed.id, "nope");
    const failedAgain = ingestSignal(
      { source: "operator", kind: "ops", title: "fail again", ref: "fail-1" },
      { notify: false },
    );
    expect(failedAgain.id).not.toBe(failed.id);
    expect(actionQueue.getAllJobs()).toHaveLength(6);
  });
});

describe("kill switch audit", () => {
  beforeEach(() => {
    delete process.env["SLACK_WEBHOOK_URL"];
    isolateDataDir();
  });

  afterEach(() => {
    restoreIsolatedEnv();
  });

  it("arms when the audit append fails and carries a warning", async () => {
    // source: third code review of the 2026-10-12 export
    const dir = dataDirOrThrow();
    rmSync(join(dir, "kill-switch.log"));
    mkdirSync(join(dir, "kill-switch.log"));
    const armed = setKillSwitch({ active: true, reason: "audit down", setBy: "human" });
    expect(armed.state.active).toBe(true);
    expect(armed.blocksWork).toBe(true);
    expect(armed.warning).toContain("audit log was not written");
    const onDisk = JSON.parse(readFileSync(join(dir, "kill-switch.json"), "utf8")) as { active: boolean };
    expect(onDisk.active).toBe(true);

    const res = await app().request("/kill-switch", {
      method: "POST",
      headers: controlHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ active: true, reason: "audit down again" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { active: boolean; warning?: string };
    expect(body.active).toBe(true);
    expect(body.warning).toContain("audit log was not written");
  });
});

describe("showcase origin, unsigned webhooks, and stale heartbeats", () => {
  beforeEach(() => {
    delete process.env["SLACK_WEBHOOK_URL"];
    isolateDataDir();
  });

  afterEach(() => {
    restoreIsolatedEnv();
  });

  it("rejects a showcase mutation with the wrong content type or origin", async () => {
    // source: third code review of the 2026-10-12 export
    // source: security review of 4e74e92
    // source: simplification round, 2026-10-13
    delete process.env["DAN_CONTROL_TOKEN"];
    process.env["DAN_LOCAL_SHOWCASE"] = "1";
    const port = serverPort();
    const host = { Host: `127.0.0.1:${port}` };
    const signal = { source: "operator", kind: "manual", title: "demo" };

    const missingType = await app().request("/signals", {
      method: "POST",
      headers: host,
      body: JSON.stringify(signal),
    });
    expect(missingType.status).toBe(400);
    expectErrorBody(await missingType.text(), "Content-Type must be application/json");

    const evil = await app().request("/signals", {
      method: "POST",
      headers: { ...host, "Content-Type": "application/json", Origin: "https://evil.example" },
      body: JSON.stringify({ ...signal, title: "evil" }),
    });
    expect(evil.status).toBe(400);
    expectErrorBody(await evil.text(), "Origin is not allowed");

    const wrongPort = await app().request("/signals", {
      method: "POST",
      headers: { ...host, "Content-Type": "application/json", Origin: `http://localhost:${port + 1}` },
      body: JSON.stringify({ ...signal, title: "wrong port" }),
    });
    expect(wrongPort.status).toBe(400);
    expectErrorBody(await wrongPort.text(), "Origin is not allowed");
    expect(actionQueue.getAllJobs()).toHaveLength(0);

    const local = await app().request("/signals", {
      method: "POST",
      headers: { ...host, "Content-Type": "application/json", Origin: `http://localhost:${port}` },
      body: JSON.stringify({ ...signal, title: "local" }),
    });
    expect(local.status).toBe(200);
    const loopback = await app().request("/signals", {
      method: "POST",
      headers: { ...host, "Content-Type": "application/json", Origin: `http://127.0.0.1:${port}` },
      body: JSON.stringify({ ...signal, title: "loopback" }),
    });
    expect(loopback.status).toBe(200);
    const curl = await app().request("/signals", {
      method: "POST",
      headers: { ...host, "Content-Type": "application/json" },
      body: JSON.stringify({ ...signal, title: "curl" }),
    });
    expect(curl.status).toBe(200);
    expect(actionQueue.getAllJobs()).toHaveLength(3);
  });

  it("refuses unsigned webhooks on a public bind and warns once on loopback", async () => {
    // source: third code review of the 2026-10-12 export
    const dir = dataDirOrThrow();
    process.env["DAN_HOST"] = "0.0.0.0";
    process.env["DAN_CONTROL_TOKEN"] = "present";
    process.env["DAN_ALLOW_UNSIGNED_WEBHOOKS"] = "1";
    expect(startupRefusal()).toBe(UNSIGNED_BIND_REFUSAL);

    const refused = await runServerAsync({
      DAN_DATA_DIR: dir,
      DAN_HOST: "0.0.0.0",
      DAN_CONTROL_TOKEN: "present",
      DAN_ALLOW_UNSIGNED_WEBHOOKS: "1",
      PORT: "39991",
    });
    expect(refused.timedOut, refused.stdout).toBe(false);
    expect(refused.code).toBe(1);
    expect(refused.stderr.trim()).toBe(UNSIGNED_BIND_REFUSAL);

    delete process.env["DAN_HOST"];
    expect(startupRefusal()).toBeNull();

    const warned = Bun.spawnSync(
      ["bun", "--no-env-file", "-e", "await import('./src/index.ts'); process.exit(0)"],
      {
        cwd: ROOT,
        env: childEnv({
          DAN_DATA_DIR: dir,
          DAN_ALLOW_UNSIGNED_WEBHOOKS: "1",
          PORT: "39992",
        }),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const text = `${warned.stdout.toString()}\n${warned.stderr.toString()}`;
    expect(warned.exitCode).toBe(0);
    expect(text.split(UNSIGNED_WARNING).length - 1).toBe(1);
  });

  it("counts an unreadable heartbeat as stale and degrades health", async () => {
    // source: third code review of the 2026-10-12 export
    const dir = dataDirOrThrow();
    writeHeartbeat("meta-cron", 60);
    writeFileSync(join(dir, "heartbeats", "broken.json"), "{not-json");
    expect(listHeartbeats().staleCount).toBeGreaterThan(0);
    const brokenHealth = await app().request("/health");
    expect(((await brokenHealth.json()) as { status: string }).status).toBe("degraded");

    if (runningAsRoot) return;
    const secret = join(dir, "heartbeats", "secret.json");
    writeFileSync(secret, "{}\n");
    chmodSync(secret, 0o000);
    try {
      expect(listHeartbeats().beats.find((beat) => beat.name === "secret")).toMatchObject({
        state: "could_not",
      });
      expect(listHeartbeats().staleCount).toBeGreaterThan(0);
      const fileHealth = await app().request("/health");
      expect(((await fileHealth.json()) as { status: string }).status).toBe("degraded");
    } finally {
      chmodSync(secret, 0o644);
    }

    chmodSync(join(dir, "heartbeats"), 0o000);
    try {
      const folder = listHeartbeats();
      expect(folder.staleCount).toBeGreaterThan(0);
      expect(folder.beats.some((beat) => "state" in beat && beat.state === "could_not")).toBe(true);
      const folderHealth = await app().request("/health");
      expect(((await folderHealth.json()) as { status: string }).status).toBe("degraded");
    } finally {
      chmodSync(join(dir, "heartbeats"), 0o755);
    }
  });

  it("places a job id that contains underscores in one code span", async () => {
    // source: third code review of the 2026-10-12 export
    const id = "job_left_right";
    const job = sampleJob(id);
    const ingested = await captureSlack(() => notifySignalIngested(job));
    expect(ingested).toContain("`job_left_right`");
    expect(ingested).not.toContain("job`_`left`_`right");
    const updated = await captureSlack(() => notifyJobUpdate(job, "human rejected"));
    expect(updated).toContain("`job_left_right`");
    expect(updated).not.toContain("job`_`left`_`right");
  });
});

function sampleJob(id: string): ActionJob {
  const now = new Date("2026-10-12T12:00:00.000Z");
  return {
    id,
    signal: { source: "operator", kind: "manual", title: "underscores" },
    status: JobStatus.PROPOSED,
    createdAt: now,
    updatedAt: now,
    diagnosis: undefined,
    proposal: undefined,
    gate: undefined,
    error: undefined,
  };
}

async function captureSlack(send: () => Promise<boolean>): Promise<string> {
  const previousFetch = globalThis.fetch;
  let captured = "";
  process.env["SLACK_WEBHOOK_URL"] = "http://127.0.0.1:9/slack-not-called";
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    captured = typeof init?.body === "string" ? init.body : "";
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  try {
    expect(await send()).toBe(true);
    return captured;
  } finally {
    globalThis.fetch = previousFetch;
    delete process.env["SLACK_WEBHOOK_URL"];
  }
}

async function runServerAsync(extra: Record<string, string>): Promise<{
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}> {
  const proc = Bun.spawn(["bun", "--no-env-file", "src/index.ts"], {
    cwd: ROOT,
    env: childEnv(extra),
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, 4000);
  const code = await proc.exited;
  clearTimeout(timer);
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { code: code ?? 1, stdout, stderr, timedOut };
}
