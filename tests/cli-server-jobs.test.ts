// source: review of the routes and CLI unit, 2026-10-13
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SERVER_DOWN_LINE = "No server is answering on 127.0.0.1. Start it with bun dev.";
const TITLE = "tower fan intake";

function cliEnv(dir: string, port: number, token: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "USER"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env["DAN_DATA_DIR"] = dir;
  env["PORT"] = String(port);
  env["DAN_CONTROL_TOKEN"] = token;
  return env;
}

function reservePort(): number {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
  const port = probe.port;
  probe.stop(true);
  if (port === undefined) throw new Error("could not reserve a port");
  return port;
}

async function spawnCli(
  dir: string,
  port: number,
  token: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const result = Bun.spawn(["bun", "--no-env-file", "run", "src/cli.ts", ...args], {
    cwd: ROOT,
    env: cliEnv(dir, port, token),
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

function startServer(dir: string, port: number, token: string): Bun.Subprocess {
  const proc = Bun.spawn(["bun", "--no-env-file", "src/index.ts"], {
    cwd: ROOT,
    env: cliEnv(dir, port, token),
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

function jsonFrom(stdout: string): unknown {
  const body = stdout
    .split("\n")
    .filter((line) => !line.startsWith("[Dan]"))
    .join("\n")
    .trim();
  if (body.length === 0) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function jobIdFrom(stdout: string): string | undefined {
  const parsed = jsonFrom(stdout);
  if (typeof parsed !== "object" || parsed === null || !("id" in parsed)) return undefined;
  return typeof parsed.id === "string" ? parsed.id : undefined;
}

function listedJob(stdout: string, id: string): Record<string, unknown> | undefined {
  const parsed = jsonFrom(stdout);
  if (!Array.isArray(parsed)) return undefined;
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    if (record["id"] === id) return record;
  }
  return undefined;
}

describe("cli job commands read the server", () => {
  it("lists and shows a server job, then shows it decided after approve", async () => {
    // source: review of the routes and CLI unit, 2026-10-13
    const dir = mkdtempSync(join(tmpdir(), "dan-cli-jobs-"));
    const port = reservePort();
    const token = "cli-jobs-token";
    const server = startServer(dir, port, token);
    try {
      expect(await waitForHealth(server, port)).toBe(true);
      const init = await spawnCli(dir, port, token, ["init"]);
      expect(init.code, `${init.stderr}\n${init.stdout}`).toBe(0);
      const ingested = await spawnCli(dir, port, token, ["ingest", "--title", TITLE, "--kind", "ops", "--ref", "cli-jobs-1"]);
      expect(ingested.code, `${ingested.stderr}\n${ingested.stdout}`).toBe(0);
      const id = jobIdFrom(ingested.stdout);
      expect(id, ingested.stdout).toBeDefined();
      if (id === undefined) return;

      const listed = await spawnCli(dir, port, token, ["jobs"]);
      expect(listed.code, `${listed.stderr}\n${listed.stdout}`).toBe(0);
      expect(listedJob(listed.stdout, id)?.["id"]).toBe(id);

      const shown = await spawnCli(dir, port, token, ["show", id]);
      expect(shown.code, `${shown.stderr}\n${shown.stdout}`).toBe(0);
      expect(shown.stdout).toContain(TITLE);

      const approved = await spawnCli(dir, port, token, ["approve", id]);
      expect(approved.code, `${approved.stderr}\n${approved.stdout}`).toBe(0);

      const decided = await spawnCli(dir, port, token, ["jobs"]);
      expect(decided.code, `${decided.stderr}\n${decided.stdout}`).toBe(0);
      const job = listedJob(decided.stdout, id);
      expect(job?.["status"]).toBe("reported");
      const gate = job?.["gate"];
      const decision =
        typeof gate === "object" && gate !== null ? (gate as Record<string, unknown>)["decision"] : undefined;
      expect(decision).toBe("approved");
    } finally {
      server.kill();
      await server.exited;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits 1 with the bun dev line when no server answers dan jobs", async () => {
    // source: review of the routes and CLI unit, 2026-10-13
    const dir = mkdtempSync(join(tmpdir(), "dan-cli-jobs-down-"));
    const port = reservePort();
    try {
      const listed = await spawnCli(dir, port, "cli-jobs-token", ["jobs"]);
      expect(listed.code).toBe(1);
      expect(listed.stderr.trim()).toBe(SERVER_DOWN_LINE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
