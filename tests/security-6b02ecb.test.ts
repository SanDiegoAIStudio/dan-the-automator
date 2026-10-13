import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  TEST_WEBHOOK_SECRET,
  app,
  controlHeaders,
  isolateDataDir,
  restoreIsolatedEnv,
  signPayload,
  validSentryPayload,
} from "./helpers";

const PUBLIC_GETS = ["/health", "/os", "/kill-switch", "/heartbeats", "/", "/status.json"];
const runningAsRoot = typeof process.getuid === "function" && process.getuid() === 0;

describe("http responses omit filesystem paths", () => {
  let dir: string;

  beforeEach(() => {
    delete process.env["SLACK_WEBHOOK_URL"];
    dir = isolateDataDir();
  });

  afterEach(() => {
    restoreIsolatedEnv();
  });

  it("public GET routes and error bodies omit the data dir and the home directory", async () => {
    // source: security review of 6b02ecb
    // source: security review of 4e74e92
    // source: simplification round, 2026-10-13
    mkdirSync(join(dir, "heartbeats", "dir.json"));
    for (const path of PUBLIC_GETS) {
      const res = await app().request(path);
      expect(res.status, path).toBe(200);
      assertNoFsPath(await res.text(), path);
    }

    rmSync(join(dir, "kill-switch.log"));
    mkdirSync(join(dir, "kill-switch.log"));
    const cleared = await app().request("/kill-switch", {
      method: "POST",
      headers: controlHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ active: false, reason: "" }),
    });
    expect(cleared.status).toBe(200);
    const clearText = await cleared.text();
    assertNoFsPath(clearText, "POST /kill-switch");
    expect(clearText).toContain("audit log was not written: kill-switch.log");

    const jobs = await app().request("/jobs", { headers: controlHeaders() });
    expect(jobs.status).toBe(200);
    assertNoFsPath(await jobs.text(), "GET /jobs");

    const payload = JSON.stringify(validSentryPayload());
    const signature = await signPayload(payload, TEST_WEBHOOK_SECRET);
    const sentry = await app().request("/webhook/sentry", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "sentry-hook-signature": signature,
      },
      body: payload,
    });
    expect(sentry.status).toBe(200);
    const sentryText = await sentry.text();
    assertNoFsPath(sentryText, "POST /webhook/sentry");
  });

  it.skipIf(runningAsRoot)(
    "internal failures return a fixed error and log the detail with the same id",
    async () => {
      // source: security review of 4e74e92
      // source: simplification round, 2026-10-13
      const logs: string[] = [];
      const previous = console.error;
      console.error = (...args: unknown[]) => {
        logs.push(args.map((arg) => (arg instanceof Error ? (arg.stack ?? arg.message) : String(arg))).join(" "));
      };
      const beatDir = join(dir, "heartbeats");
      try {
        chmodSync(beatDir, 0o000);
        const beatsDetail = readError(() => {
          readdirSync(beatDir);
        });
        expect(beatsDetail.length).toBeGreaterThan(0);
        const beats = await app().request("/heartbeats");
        await assertHiddenFailure(beats, logs, beatsDetail);

        rmSync(join(dir, "kill-switch.json"));
        mkdirSync(join(dir, "kill-switch.json"));
        const switchDetail = readError(() => {
          readFileSync(join(dir, "kill-switch.json"), "utf8");
        });
        expect(switchDetail.length).toBeGreaterThan(0);
        const ks = await app().request("/kill-switch");
        await assertHiddenFailure(ks, logs, switchDetail);
      } finally {
        console.error = previous;
        try {
          chmodSync(beatDir, 0o755);
        } catch {
          // the folder is already writable
        }
      }
    },
  );

  it("keeps a signal title that contains the data dir and a quote", async () => {
    // source: security review of 9eb71a1
    const title = `${dir}/jobs.json "quoted"`;
    expect(title.length).toBeLessThanOrEqual(200);
    const res = await app().request("/signals", {
      method: "POST",
      headers: controlHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ source: "operator", kind: "manual", title }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as { job?: { signal?: { title?: string } } };
    expect(body.job?.signal?.title).toBe(title);
  });

  function assertNoFsPath(text: string, label: string): void {
    expect(text, label).not.toContain(dir);
    const home = homedir();
    if (home.length > 1) expect(text, label).not.toContain(home);
    const envHome = process.env["HOME"];
    if (envHome !== undefined && envHome.length > 1 && envHome !== home) {
      expect(text, label).not.toContain(envHome);
    }
  }
});

function readError(run: () => void): string {
  try {
    run();
  } catch (err: unknown) {
    return err instanceof Error ? err.message : String(err);
  }
  return "";
}

async function assertHiddenFailure(res: Response, logs: string[], detail: string): Promise<void> {
  expect(res.status).toBe(500);
  const text = await res.text();
  const body: unknown = JSON.parse(text);
  if (typeof body !== "object" || body === null) throw new Error("error body is not an object");
  const record = body as Record<string, unknown>;
  expect(record["error"]).toBe("could_not");
  expect(record["id"]).toMatch(/^[0-9a-f]{8}$/);
  expect(Object.keys(record).sort()).toEqual(["error", "id"]);
  expect(text).not.toContain(detail);
  expect(text).not.toMatch(/\/\S+\/\S+/);
  const id = record["id"];
  const line = logs.find((entry) => typeof id === "string" && entry.includes(`error ${id}`));
  expect(line, logs.join("\n")).toContain(detail);
}

