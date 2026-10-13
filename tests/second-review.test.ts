import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BIND_REFUSAL, isLoopbackHost, serverHost, serverPort, startupRefusal } from "../src/config";
import { diagnose, propose } from "../src/diagnose";
import { fleetSummary } from "../src/fleet";
import { listHeartbeats, writeHeartbeat } from "../src/heartbeats";
import { readKillSwitch, setKillSwitch } from "../src/kill-switch";
import { ingestSignal } from "../src/pipeline";
import { runCli } from "../src/cli";
import { JobStatus } from "../src/types";
import { app, controlHeaders, isolateDataDir, restoreIsolatedEnv } from "./helpers";

const ROOT = join(import.meta.dir, "..");
const PUBLIC_ROUTES = new Set<string>([
  "GET /health",
  "GET /os",
  "GET /kill-switch",
  "GET /heartbeats",
  "GET /",
  "GET /status.json",
]);

function childEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "USER"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) env[key] = value;
  return env;
}

function spawnBun(args: string[], extra: Record<string, string>): { code: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["bun", "--no-env-file", ...args], {
    cwd: ROOT,
    env: childEnv(extra),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode ?? 1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

async function spawnBunAsync(
  args: string[],
  extra: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const result = Bun.spawn(["bun", "--no-env-file", ...args], {
    cwd: ROOT,
    env: childEnv(extra),
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

async function runServer(extra: Record<string, string>): Promise<{
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

function concretePath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, "probe");
}

function isCutawayAsset(method: string, path: string): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  if (path.includes(":") || path.includes("..")) return false;
  const relative = path === "/" ? "index.html" : path.replace(/^\//, "");
  if (relative.length === 0 || relative.endsWith("/")) return false;
  const full = join(ROOT, "public", relative);
  if (!existsSync(full)) return false;
  return statSync(full).isFile();
}

function isPublicRoute(method: string, path: string): boolean {
  return PUBLIC_ROUTES.has(`${method} ${path}`) || isCutawayAsset(method, path);
}

async function callRoute(method: string, path: string, headers?: Record<string, string>): Promise<Response> {
  const upper = method.toUpperCase();
  if (upper === "GET" || upper === "HEAD") {
    return app().request(concretePath(path), { method: upper, headers });
  }
  return app().request(concretePath(path), {
    method: upper,
    headers: { "Content-Type": "application/json", ...headers },
    body: "{}",
  });
}

async function capture(run: () => Promise<number>): Promise<{ code: number; stdout: string; stderr: string }> {
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

describe("every registered route is public or token gated", () => {
  beforeEach(() => {
    delete process.env["SLACK_WEBHOOK_URL"];
    isolateDataDir();
  });

  afterEach(() => {
    restoreIsolatedEnv();
  });

  it("answers 503 with no token and 401 with a wrong token, unless the route is public", async () => {
    // source: second code review of the 2026-10-12 export
    delete process.env["DAN_CONTROL_TOKEN"];
    delete process.env["DAN_LOCAL_SHOWCASE"];
    delete process.env["SENTRY_WEBHOOK_SECRET"];
    delete process.env["DAN_ALLOW_UNSIGNED_WEBHOOKS"];

    const routes = app().routes;
    const seen = new Set(routes.map((route) => `${route.method.toUpperCase()} ${route.path}`));
    expect(routes.length).toBeGreaterThan(10);
    for (const key of PUBLIC_ROUTES) expect(seen.has(key), key).toBe(true);
    expect(seen.has("POST /webhook/trigger")).toBe(true);
    expect(seen.has("POST /trigger")).toBe(true);

    for (const route of routes) {
      const method = route.method.toUpperCase();
      const key = `${method} ${route.path}`;
      if (isPublicRoute(method, route.path)) {
        const opened = await callRoute(method, route.path);
        expect(opened.status, key).not.toBe(503);
        expect(opened.status, key).not.toBe(401);
        continue;
      }
      const closed = await callRoute(method, route.path);
      expect(closed.status, key).toBe(503);
    }

    process.env["DAN_CONTROL_TOKEN"] = "census-control-token";
    process.env["SENTRY_WEBHOOK_SECRET"] = "census-webhook-secret";
    for (const route of routes) {
      const method = route.method.toUpperCase();
      const key = `${method} ${route.path}`;
      if (isPublicRoute(method, route.path)) continue;
      const wrong = await callRoute(method, route.path, { Authorization: "Bearer wrong-token" });
      expect(wrong.status, key).toBe(401);
    }
  });

  it("requires a localhost Host header on every control route in showcase mode", async () => {
    // source: simplification round, 2026-10-13
    delete process.env["DAN_CONTROL_TOKEN"];
    process.env["DAN_LOCAL_SHOWCASE"] = "1";
    const port = serverPort();
    const routes = app().routes;
    for (const route of routes) {
      const method = route.method.toUpperCase();
      const key = `${method} ${route.path}`;
      if (isPublicRoute(method, route.path)) {
        const opened = await callRoute(method, route.path);
        expect(opened.status, key).not.toBe(400);
        continue;
      }
      if (method === "POST" && route.path === "/webhook/sentry") {
        const sentry = await callRoute(method, route.path);
        expect(sentry.status, key).toBe(401);
        continue;
      }
      const denied = await callRoute(method, route.path);
      expect(denied.status, key).toBe(400);
      const body = (await denied.json()) as { error?: string; id?: string };
      expect(body.error, key).toBe("Host is not allowed");
      expect(body.id, key).toMatch(/^[0-9a-f]{8}$/);
    }
    const listed = await app().request("/jobs", { headers: { Host: `localhost:${port}` } });
    expect(listed.status).toBe(200);
    const loopback = await app().request("/jobs", { headers: { Host: `127.0.0.1:${port}` } });
    expect(loopback.status).toBe(200);
    const wrong = await app().request("/jobs", { headers: { Host: `localhost:${port + 1}` } });
    expect(wrong.status).toBe(400);
  });
});

describe("bind, data dir, and kill-switch durability", () => {
  beforeEach(() => {
    delete process.env["SLACK_WEBHOOK_URL"];
    isolateDataDir();
  });

  afterEach(() => {
    restoreIsolatedEnv();
  });

  it("listens on 127.0.0.1 unless DAN_HOST is set, and refuses a public bind without a token", async () => {
    // source: second code review of the 2026-10-12 export
    delete process.env["DAN_CONTROL_TOKEN"];
    delete process.env["DAN_LOCAL_SHOWCASE"];
    delete process.env["DAN_HOST"];
    expect(serverHost()).toBe("127.0.0.1");
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.0.0.2")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("::")).toBe(false);
    expect(startupRefusal()).toBeNull();

    process.env["DAN_HOST"] = "0.0.0.0";
    process.env["DAN_LOCAL_SHOWCASE"] = "1";
    expect(startupRefusal()).toBe(BIND_REFUSAL);
    delete process.env["DAN_LOCAL_SHOWCASE"];
    expect(startupRefusal()).toBe(BIND_REFUSAL);
    process.env["DAN_CONTROL_TOKEN"] = "present";
    expect(startupRefusal()).toBeNull();

    const dir = dataDirOrThrow();
    const imported = spawnBun(
      ["-e", 'const m = await import("./src/index.ts"); console.log("HOSTNAME=" + m.default.hostname); process.exit(0)'],
      { DAN_DATA_DIR: dir },
    );
    expect(imported.code, `${imported.stderr}\n${imported.stdout}`).toBe(0);
    expect(imported.stdout).toContain("HOSTNAME=127.0.0.1");
    expect(imported.stdout).toContain(`[Dan] Data dir: ${dir}`);

    const port = String(30000 + Math.floor(Math.random() * 20000));
    const showcased = await runServer({
      DAN_DATA_DIR: dir,
      DAN_HOST: "0.0.0.0",
      DAN_LOCAL_SHOWCASE: "1",
      PORT: port,
    });
    expect(showcased.timedOut, showcased.stdout).toBe(false);
    expect(showcased.code).toBe(1);
    expect(showcased.stderr.trim()).toBe(BIND_REFUSAL);
    expect(showcased.stdout).toBe("");

    const closed = await runServer({
      DAN_DATA_DIR: dir,
      DAN_HOST: "10.1.2.3",
      PORT: String(Number(port) + 1),
    });
    expect(closed.timedOut, closed.stdout).toBe(false);
    expect(closed.code).toBe(1);
    expect(closed.stderr.trim()).toBe(BIND_REFUSAL);
  });

  it("treats an empty DAN_DATA_DIR as an error and prints the resolved directory", async () => {
    // source: second code review of the 2026-10-12 export
    const fresh = mkdtempSync(join(tmpdir(), "dan-status-"));
    try {
      const status = spawnBun(["run", "src/cli.ts", "ks", "status"], { DAN_DATA_DIR: fresh });
      expect(status.code, status.stderr).toBe(0);
      expect(status.stdout.split("\n").filter((line) => line.startsWith("[Dan] Data dir:"))).toEqual([
        `[Dan] Data dir: ${fresh}`,
      ]);
      expect(status.stdout).toContain("state file missing");

      const healthServer = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch() {
          return new Response(JSON.stringify({ queue: {} }), {
            headers: { "content-type": "application/json" },
          });
        },
      });
      let health: { code: number; stdout: string; stderr: string };
      try {
        health = await spawnBunAsync(["run", "src/cli.ts", "health"], {
          DAN_DATA_DIR: fresh,
          PORT: String(healthServer.port),
        });
      } finally {
        healthServer.stop(true);
      }
      expect(health.code, health.stderr).toBe(0);
      expect(health.stdout.split("\n").filter((line) => line.startsWith("[Dan] Data dir:"))).toEqual([
        `[Dan] Data dir: ${fresh}`,
      ]);

      const gate = spawnBun(["run", "src/cli.ts", "ks", "gate"], { DAN_DATA_DIR: fresh });
      expect(gate.code).toBe(2);
      expect(gate.stdout).toBe("");
      expect(gate.stderr).not.toContain("Data dir");
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }

    process.env["DAN_DATA_DIR"] = "";
    const cli = await capture(() => runCli(["ks", "status"]));
    expect(cli.code).toBe(1);
    expect(cli.stderr).toContain("DAN_DATA_DIR is empty");

    const server = await runServer({ DAN_DATA_DIR: "", PORT: "39876" });
    expect(server.timedOut, server.stdout).toBe(false);
    expect(server.code).toBe(1);
    expect(server.stderr.trim()).toBe("DAN_DATA_DIR is empty");
    expect(server.stdout).toBe("");
  });

  it("reports an unreadable heartbeat and still answers health", async () => {
    // source: second code review of the 2026-10-12 export
    const dir = dataDirOrThrow();
    const beatDir = join(dir, "heartbeats");
    writeHeartbeat("meta-cron", 60);
    writeFileSync(join(beatDir, "broken.json"), "{not-json");
    writeFileSync(join(beatDir, "odd.json"), "{}\n");
    mkdirSync(join(beatDir, "dir.json"));
    expect(readdirSync(beatDir).some((name) => name.endsWith(".tmp"))).toBe(false);

    const listed = listHeartbeats();
    const broken = listed.beats.find((beat) => beat.name === "broken");
    const odd = listed.beats.find((beat) => beat.name === "odd");
    const directory = listed.beats.find((beat) => beat.name === "dir");
    const fresh = listed.beats.find((beat) => beat.name === "meta-cron");
    expect(broken).toMatchObject({ name: "broken", state: "could_not" });
    expect(odd).toMatchObject({ name: "odd", state: "could_not" });
    expect(directory).toMatchObject({ name: "dir", state: "could_not" });
    expect(broken && "reason" in broken && broken.reason.length > 0).toBe(true);
    expect(fresh && "stale" in fresh && fresh.stale).toBe(false);

    const health = await app().request("/health");
    expect(health.status).toBe(200);
    const beats = await app().request("/heartbeats");
    expect(beats.status).toBe(200);
    const body = (await beats.json()) as { beats: Array<{ name: string; state?: string }> };
    expect(body.beats.some((beat) => beat.name === "broken" && beat.state === "could_not")).toBe(true);

    const healthServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response(JSON.stringify({ queue: {} }), {
          headers: { "content-type": "application/json" },
        });
      },
    });
    const savedPort = process.env["PORT"];
    process.env["PORT"] = String(healthServer.port);
    let cliHealth: { code: number; stdout: string; stderr: string };
    try {
      cliHealth = await capture(() => runCli(["health"]));
    } finally {
      healthServer.stop(true);
      if (savedPort === undefined) delete process.env["PORT"];
      else process.env["PORT"] = savedPort;
    }
    expect(cliHealth.code, cliHealth.stderr).toBe(0);
    const cliBeats = await capture(() => runCli(["heartbeats"]));
    expect(cliBeats.code).toBe(0);
    expect(cliBeats.stdout).toContain('"state": "could_not"');
  });

  it("keeps the written state when the audit append fails and reports a warning", () => {
    // source: second code review of the 2026-10-12 export
    // source: simplification round, 2026-10-13
    const dir = dataDirOrThrow();
    const statePath = join(dir, "kill-switch.json");
    const logPath = join(dir, "kill-switch.log");
    setKillSwitch({ active: true, reason: "hold the fleet", setBy: "human" });
    const armedLog = readFileSync(logPath, "utf8");
    expect(armedLog).toContain("active=true");
    expect(armedLog).toContain("hold the fleet");
    const held = ingestSignal(
      { source: "operator", kind: "manual", title: "stay held", ref: "audit-held" },
      { notify: false },
    );
    expect(held.status).toBe(JobStatus.HELD);

    rmSync(logPath);
    mkdirSync(logPath);
    const cleared = setKillSwitch({ active: false, reason: "", setBy: "human" });
    expect(cleared.blocksWork).toBe(false);
    expect(cleared.warning).toContain("audit log was not written");
    const onDisk = JSON.parse(readFileSync(statePath, "utf8")) as { active: boolean };
    expect(onDisk.active).toBe(false);
    expect(held.status).toBe(JobStatus.PROPOSED);
    expect(readdirSync(dir).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("leaves an expired switch file in place and releases held jobs on the next ingest or listing", async () => {
    // source: simplification round, 2026-10-13
    const dir = dataDirOrThrow();
    const statePath = join(dir, "kill-switch.json");
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    setKillSwitch({ active: true, reason: "short hold", setBy: "human", expiresAt: future });
    const first = ingestSignal(
      { source: "operator", kind: "manual", title: "first held", ref: "exp-1" },
      { notify: false },
    );
    const second = ingestSignal(
      { source: "operator", kind: "manual", title: "second held", ref: "exp-2" },
      { notify: false },
    );
    expect(first.status).toBe(JobStatus.HELD);
    expect(second.status).toBe(JobStatus.HELD);

    const stored = JSON.parse(readFileSync(statePath, "utf8")) as { expires_at?: string; active: boolean };
    stored.expires_at = new Date(Date.now() - 60 * 1000).toISOString();
    const expiredFile = `${JSON.stringify(stored, null, 2)}\n`;
    writeFileSync(statePath, expiredFile);
    const ks = readKillSwitch();
    expect(ks.mode).toBe("expired");
    expect(ks.blocksWork).toBe(false);
    expect(ks.state.active).toBe(true);
    expect(first.status).toBe(JobStatus.HELD);
    expect(second.status).toBe(JobStatus.HELD);
    expect(readFileSync(statePath, "utf8")).toBe(expiredFile);

    const listed = await app().request("/jobs", { headers: controlHeaders() });
    expect(listed.status).toBe(200);
    expect(first.status).toBe(JobStatus.PROPOSED);
    expect(second.status).toBe(JobStatus.PROPOSED);
    expect(first.proposal).toBeDefined();
    expect(second.proposal).toBeDefined();
    expect(first.error).toBeUndefined();
    expect(second.updatedAt.getTime()).toBeGreaterThan(first.updatedAt.getTime());
    expect(readFileSync(statePath, "utf8")).toBe(expiredFile);

    setKillSwitch({ active: true, reason: "short hold", setBy: "human", expiresAt: future });
    const third = ingestSignal(
      { source: "operator", kind: "manual", title: "third held", ref: "exp-3" },
      { notify: false },
    );
    const fourth = ingestSignal(
      { source: "operator", kind: "manual", title: "fourth held", ref: "exp-4" },
      { notify: false },
    );
    expect(third.status).toBe(JobStatus.HELD);
    expect(fourth.status).toBe(JobStatus.HELD);
    const again = JSON.parse(readFileSync(statePath, "utf8")) as { expires_at?: string };
    again.expires_at = new Date(Date.now() - 60 * 1000).toISOString();
    const secondFile = `${JSON.stringify(again, null, 2)}\n`;
    writeFileSync(statePath, secondFile);
    const fifth = ingestSignal(
      { source: "operator", kind: "manual", title: "fifth", ref: "exp-5" },
      { notify: false },
    );
    expect(third.status).toBe(JobStatus.PROPOSED);
    expect(fourth.status).toBe(JobStatus.PROPOSED);
    expect(fourth.updatedAt.getTime()).toBeGreaterThan(third.updatedAt.getTime());
    expect(fifth.status).toBe(JobStatus.PROPOSED);
    expect(readFileSync(statePath, "utf8")).toBe(secondFile);
  });
});

describe("plain diagnosis copy", () => {
  beforeEach(() => {
    delete process.env["SLACK_WEBHOOK_URL"];
  });

  it("ends diagnosis and proposal text on the review sentences", () => {
    // source: second code review of the 2026-10-12 export
    expect(diagnose({ source: "operator", kind: "revenue", title: "invoice" }).summary).toBe(
      "Held until a person reviews it.",
    );
    const kinds = ["heartbeat", "content", "ops", "manual"] as const;
    for (const kind of kinds) {
      expect(diagnose({ source: "operator", kind, title: "t" }).summary.endsWith("Queued for review.")).toBe(true);
    }
    expect(diagnose({ source: "operator", kind: "error", title: "t" }).summary.endsWith("Queued for review.")).toBe(true);
    expect(
      diagnose({ source: "operator", kind: "error", title: "t", file: "a.ts" }).summary.endsWith("Queued for review."),
    ).toBe(true);
    const proposal = propose(
      diagnose({ source: "operator", kind: "ops", title: "restart" }),
      { source: "operator", kind: "ops", title: "restart" },
    );
    expect(proposal.details.note).toBe("Proposal only. No code is written and no PR is opened.");
    expect(fleetSummary().rule).toBe("Dormant agents start on a matching keyword.");
  });
});

function dataDirOrThrow(): string {
  const dir = process.env["DAN_DATA_DIR"];
  if (!dir) throw new Error("expected isolated data dir");
  return dir;
}
