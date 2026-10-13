import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { BIND_REFUSAL, serverPort, startupRefusal } from "../src/config";
import { listHeartbeats } from "../src/heartbeats";
import { readKillSwitch } from "../src/kill-switch";
import {
  escapeSlackMrkdwn,
  notifyIssueDetected,
  notifyJobUpdate,
  notifyKillSwitch,
  notifySignalIngested,
  slackPlainText,
} from "../src/notify/slack";
import { ingestSignal } from "../src/pipeline";
import { actionQueue } from "../src/queue";
import { JobStatus, type ActionJob, type KillSwitchState } from "../src/types";
import { app, isolateDataDir, restoreIsolatedEnv } from "./helpers";

const SIGNAL_BODY = "signal-body-sentinel-7f3a";

function expectErrorBody(text: string, error: string): void {
  // source: security review of 4e74e92
  const body: unknown = JSON.parse(text);
  if (typeof body !== "object" || body === null) throw new Error("error body is not an object");
  const record = body as Record<string, unknown>;
  expect(record["error"]).toBe(error);
  expect(record["id"]).toMatch(/^[0-9a-f]{8}$/);
  expect(Object.keys(record).sort()).toEqual(["error", "id"]);
}
const CONTROL_TOKEN = "control-token-sentinel-7f3a";
const SHOWCASE_WARNING =
  "[Dan] DAN_LOCAL_SHOWCASE=1; control routes are open because DAN_CONTROL_TOKEN is unset";

function jsonRequest(path: string, body: unknown, headers?: Record<string, string>) {
  return app().request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function bearer(token = CONTROL_TOKEN): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

describe("control token fails closed", () => {
  beforeEach(() => {
    // source: second code review of the 2026-10-12 export
    delete process.env["SLACK_WEBHOOK_URL"];
    isolateDataDir();
    delete process.env["DAN_LOCAL_SHOWCASE"];
    delete process.env["DAN_CONTROL_TOKEN"];
    delete process.env["DAN_ALLOW_UNSIGNED_WEBHOOKS"];
  });

  afterEach(() => {
    restoreIsolatedEnv();
  });

  it("returns 503 and changes nothing when the control token is unset", async () => {
    // source: security review of the 2026-10-12 export
    // source: security review of 4e74e92
    const job = ingestSignal(
      { source: "operator", kind: "manual", title: "hidden title", body: SIGNAL_BODY },
      { notify: false },
    );
    const beforeSwitch = readKillSwitch();
    const beforeJobs = actionQueue.getAllJobs().length;

    const kill = await jsonRequest("/kill-switch", { active: true, reason: "should-not-arm" });
    expect(kill.status).toBe(503);
    expectErrorBody(await kill.text(), "control token not configured");
    const afterSwitch = readKillSwitch();
    expect(afterSwitch.blocksWork).toBe(beforeSwitch.blocksWork);
    expect(afterSwitch.state.active).toBe(beforeSwitch.state.active);
    expect(afterSwitch.state.reason).toBe(beforeSwitch.state.reason);

    const beat = await jsonRequest("/heartbeats", { name: "should-not-write", cadenceSeconds: 30 });
    expect(beat.status).toBe(503);
    expectErrorBody(await beat.text(), "control token not configured");
    expect(listHeartbeats().beats.some((item) => item.name === "should-not-write")).toBe(false);

    const signal = await jsonRequest("/signals", {
      source: "operator",
      kind: "manual",
      title: "should-not-ingest",
      body: SIGNAL_BODY,
    });
    expect(signal.status).toBe(503);
    expectErrorBody(await signal.text(), "control token not configured");

    const trigger = await jsonRequest("/trigger", { title: "should-not-trigger", body: SIGNAL_BODY });
    expect(trigger.status).toBe(503);
    expectErrorBody(await trigger.text(), "control token not configured");

    const webhookTrigger = await jsonRequest("/webhook/trigger", {
      title: "should-not-webhook-trigger",
      body: SIGNAL_BODY,
    });
    expect(webhookTrigger.status).toBe(503);
    expectErrorBody(await webhookTrigger.text(), "control token not configured");
    expect(actionQueue.getAllJobs().length).toBe(beforeJobs);

    const listed = await app().request("/jobs");
    expect(listed.status).toBe(503);
    expectErrorBody(await listed.text(), "control token not configured");

    const one = await app().request(`/jobs/${job.id}`);
    expect(one.status).toBe(503);
    const oneText = await one.text();
    expectErrorBody(oneText, "control token not configured");
    expect(oneText).not.toContain(SIGNAL_BODY);

    const approved = await app().request(`/jobs/${job.id}/approve`, { method: "POST" });
    expect(approved.status).toBe(503);
    expectErrorBody(await approved.text(), "control token not configured");

    const rejected = await jsonRequest(`/jobs/${job.id}/reject`, { reason: "should-not-apply" });
    expect(rejected.status).toBe(503);
    expectErrorBody(await rejected.text(), "control token not configured");
    expect(actionQueue.getJob(job.id)?.status).toBe(JobStatus.PROPOSED);
    expect(actionQueue.getJob(job.id)?.gate).toBeUndefined();
  });

  it("does not treat other showcase values as permission to skip the control token", async () => {
    // source: security review of the 2026-10-12 export
    // source: security review of 4e74e92
    for (const value of ["true", "yes", "0", ""]) {
      process.env["DAN_LOCAL_SHOWCASE"] = value;
      const res = await jsonRequest("/signals", { source: "operator", kind: "manual", title: "nope" });
      expect(res.status).toBe(503);
      expectErrorBody(await res.text(), "control token not configured");
    }
    expect(actionQueue.getAllJobs()).toHaveLength(0);
  });

  it("keeps control routes open when DAN_LOCAL_SHOWCASE is exactly 1 and no token is set", async () => {
    // source: security review of the 2026-10-12 export
    // source: simplification round, 2026-10-13
    process.env["DAN_LOCAL_SHOWCASE"] = "1";
    const host = { Host: `127.0.0.1:${serverPort()}` };

    const signal = await jsonRequest("/signals", { source: "operator", kind: "manual", title: "demo" }, host);
    expect(signal.status).toBe(200);
    const created = (await signal.json()) as { job: { id: string } };

    const trigger = await jsonRequest("/trigger", { title: "demo trigger" }, host);
    expect(trigger.status).toBe(200);

    const webhookTrigger = await jsonRequest("/webhook/trigger", { title: "demo webhook trigger" }, host);
    expect(webhookTrigger.status).toBe(200);

    const listed = await app().request("/jobs", { headers: host });
    expect(listed.status).toBe(200);
    const one = await app().request(`/jobs/${created.job.id}`, { headers: host });
    expect(one.status).toBe(200);

    const approved = await app().request(`/jobs/${created.job.id}/approve`, {
      method: "POST",
      headers: { ...host, "Content-Type": "application/json" },
    });
    expect(approved.status).toBe(200);

    const rejected = await jsonRequest("/trigger", { title: "demo reject" }, host);
    expect(rejected.status).toBe(200);
    const second = (await rejected.json()) as { jobId: string };
    const deny = await jsonRequest(`/jobs/${second.jobId}/reject`, { reason: "not now" }, host);
    expect(deny.status).toBe(200);

    const kill = await jsonRequest("/kill-switch", { active: true, reason: "demo arm" }, host);
    expect(kill.status).toBe(200);
    expect(readKillSwitch().blocksWork).toBe(true);

    const beat = await jsonRequest("/heartbeats", { name: "demo-beat", cadenceSeconds: 60 }, host);
    expect(beat.status).toBe(200);
    expect(listHeartbeats().beats.some((item) => item.name === "demo-beat")).toBe(true);
  });

  it("stays 401 for a missing or wrong bearer when a token is set", async () => {
    // source: security review of the 2026-10-12 export
    // source: security review of 4e74e92
    process.env["DAN_CONTROL_TOKEN"] = CONTROL_TOKEN;
    const job = ingestSignal(
      { source: "operator", kind: "manual", title: "gated", body: SIGNAL_BODY },
      { notify: false },
    );

    const missing = await jsonRequest("/signals", { source: "operator", kind: "manual", title: "no" });
    expect(missing.status).toBe(401);
    expectErrorBody(await missing.text(), "Unauthorized");

    const wrong = await jsonRequest("/trigger", { title: "no" }, bearer("wrong-token"));
    expect(wrong.status).toBe(401);
    const webhookWrong = await jsonRequest("/webhook/trigger", { title: "no" }, bearer("wrong-token"));
    expect(webhookWrong.status).toBe(401);
    expect(actionQueue.getAllJobs().some((item) => item.signal.title === "no")).toBe(false);

    const listed = await app().request("/jobs", { headers: bearer("wrong-token") });
    expect(listed.status).toBe(401);
    expect(await listed.text()).not.toContain(SIGNAL_BODY);

    const rejected = await jsonRequest(`/jobs/${job.id}/reject`, { reason: "nope" }, bearer("wrong-token"));
    expect(rejected.status).toBe(401);
    expect(actionQueue.getJob(job.id)?.status).toBe(JobStatus.PROPOSED);

    const ok = await jsonRequest(
      "/signals",
      { source: "operator", kind: "manual", title: "yes" },
      bearer(),
    );
    expect(ok.status).toBe(200);
    const created = (await ok.json()) as { job: { id: string } };

    const trigger = await jsonRequest("/trigger", { title: "yes trigger" }, bearer());
    expect(trigger.status).toBe(200);
    const webhookTrigger = await jsonRequest("/webhook/trigger", { title: "yes webhook trigger" }, bearer());
    expect(webhookTrigger.status).toBe(200);

    const jobs = await app().request("/jobs", { headers: bearer() });
    expect(jobs.status).toBe(200);
    const fetched = await app().request(`/jobs/${created.job.id}`, { headers: bearer() });
    expect(fetched.status).toBe(200);
    expect(await fetched.text()).toContain("yes");
  });

  it("still requires the bearer when the showcase flag is also set", async () => {
    // source: security review of the 2026-10-12 export
    // source: simplification round, 2026-10-13
    process.env["DAN_CONTROL_TOKEN"] = CONTROL_TOKEN;
    process.env["DAN_LOCAL_SHOWCASE"] = "1";
    const host = { Host: `127.0.0.1:${serverPort()}` };
    const res = await app().request("/jobs", { headers: host });
    expect(res.status).toBe(401);
    const badHost = await app().request("/jobs", { headers: { ...bearer(), Host: "evil.example:3456" } });
    expect(badHost.status).toBe(400);
    expectErrorBody(await badHost.text(), "Host is not allowed");
    const ok = await app().request("/jobs", { headers: { ...bearer(), ...host } });
    expect(ok.status).toBe(200);
  });

  it("treats an empty control token as unset", async () => {
    // source: simplification round, 2026-10-13
    for (const value of ["", "   "]) {
      process.env["DAN_CONTROL_TOKEN"] = value;
      delete process.env["DAN_LOCAL_SHOWCASE"];
      delete process.env["DAN_HOST"];
      const res = await jsonRequest("/signals", { source: "operator", kind: "manual", title: "empty token" });
      expect(res.status).toBe(503);
      expectErrorBody(await res.text(), "control token not configured");
    }
    process.env["DAN_HOST"] = "0.0.0.0";
    process.env["DAN_CONTROL_TOKEN"] = "";
    expect(startupRefusal()).toBe(BIND_REFUSAL);
    process.env["DAN_CONTROL_TOKEN"] = "   ";
    expect(startupRefusal()).toBe(BIND_REFUSAL);
  });
});

describe("public routes stay public", () => {
  beforeEach(() => {
    delete process.env["SLACK_WEBHOOK_URL"];
    isolateDataDir();
    delete process.env["DAN_LOCAL_SHOWCASE"];
    process.env["DAN_CONTROL_TOKEN"] = CONTROL_TOKEN;
  });

  afterEach(() => {
    restoreIsolatedEnv();
  });

  it("does not return a signal body or the control token", async () => {
    // source: security review of the 2026-10-12 export
    ingestSignal(
      { source: "operator", kind: "manual", title: "hidden title", body: SIGNAL_BODY },
      { notify: false },
    );
    const paths = ["/health", "/os", "/kill-switch", "/heartbeats", "/", "/status.json"];
    for (const path of paths) {
      const res = await app().request(path);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text, path).not.toContain(SIGNAL_BODY);
      expect(text, path).not.toContain(CONTROL_TOKEN);
    }
  });
});

describe("local showcase warning", () => {
  beforeEach(() => {
    delete process.env["SLACK_WEBHOOK_URL"];
  });

  function childEnv(extra: Record<string, string>): Record<string, string> {
    const env: Record<string, string> = {};
    for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "USER"]) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    for (const [key, value] of Object.entries(extra)) env[key] = value;
    return env;
  }

  function bootLog(extra: Record<string, string>): { code: number; text: string } {
    const result = Bun.spawnSync(["bun", "--no-env-file", "-e", "await import('./src/index.ts'); process.exit(0)"], {
      cwd: join(import.meta.dir, ".."),
      env: childEnv(extra),
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = result.stdout.toString();
    const stderr = result.stderr.toString();
    return { code: result.exitCode ?? 1, text: `${stdout}\n${stderr}` };
  }

  it("logs one warning at start when the showcase flag is on and no token is set", () => {
    // source: security review of the 2026-10-12 export
    const booted = bootLog({ DAN_LOCAL_SHOWCASE: "1" });
    expect(booted.code, booted.text).toBe(0);
    expect(booted.text.split(SHOWCASE_WARNING).length - 1, booted.text).toBe(1);
  });

  it("does not log the showcase warning when a token is set or the flag is not exactly 1", () => {
    // source: security review of the 2026-10-12 export
    const withToken = bootLog({ DAN_LOCAL_SHOWCASE: "1", DAN_CONTROL_TOKEN: "set-for-warning-test" });
    expect(withToken.code, withToken.text).toBe(0);
    expect(withToken.text).not.toContain(SHOWCASE_WARNING);

    const otherFlag = bootLog({ DAN_LOCAL_SHOWCASE: "true" });
    expect(otherFlag.code, otherFlag.text).toBe(0);
    expect(otherFlag.text).not.toContain(SHOWCASE_WARNING);

    const unset = bootLog({});
    expect(unset.code, unset.text).toBe(0);
    expect(unset.text).not.toContain(SHOWCASE_WARNING);
  });
});

describe("Slack mrkdwn escaping", () => {
  const maliciousTitle = "<!channel> *x* <https://evil.example|click>";

  beforeEach(() => {
    delete process.env["SLACK_WEBHOOK_URL"];
    isolateDataDir();
  });

  afterEach(() => {
    restoreIsolatedEnv();
  });

  function sampleJob(title: string, source: string, id: string): ActionJob {
    const now = new Date("2026-10-12T12:00:00.000Z");
    return {
      id,
      signal: { source, kind: "manual", title, body: "body <raw>" },
      status: JobStatus.PROPOSED,
      createdAt: now,
      updatedAt: now,
      diagnosis: undefined,
      proposal: undefined,
      gate: { decidedBy: "human", decision: "rejected", reason: "reason <raw>" },
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

  it("escapes a malicious title in the built message", async () => {
    // source: security review of the 2026-10-12 export
    // source: second code review of the 2026-10-12 export
    const source = "a`b_c*d~e&f<g>h";
    const id = "job_1";
    const message = await captureSlack(() =>
      notifySignalIngested(sampleJob(maliciousTitle, source, id)),
    );
    expect(message).not.toContain("<!channel>");
    expect(message).not.toContain("<https://");
    expect(message).not.toContain("*x*");
    expect(message).toContain(
      "&lt;!channel&gt; `*`x`*` &lt;https://evil.example|click&gt;",
    );
    expect(message).not.toContain(source);
    expect(message).toContain(escapeSlackMrkdwn(source));
    // source: third code review of the 2026-10-12 export
    expect(message).toContain("`job_1`");
    expect(message).not.toContain("job`_`1");
    expect(message).toContain("A person approves or rejects this job.");
    expect(message).not.toContain("A human still gates.");

    const parsed = JSON.parse(message) as {
      blocks?: Array<{ text?: { type?: string; text?: string }; elements?: Array<{ type?: string; text?: string }> }>;
    };
    for (const block of parsed.blocks ?? []) {
      if (block.text?.type === "plain_text") {
        expect(block.text.text?.length ?? 0).toBeLessThanOrEqual(150);
      }
      for (const element of block.elements ?? []) {
        if (element.type === "plain_text") {
          expect(element.text?.length ?? 0).toBeLessThanOrEqual(150);
        }
      }
    }
  });

  it("neutralises backticks, asterisks, underscores, and tildes, and escapes entities", () => {
    // source: security review of the 2026-10-12 export
    expect(escapeSlackMrkdwn("&<>")).toBe("&amp;&lt;&gt;");
    expect(escapeSlackMrkdwn("*bold*")).toBe("`*`bold`*`");
    expect(escapeSlackMrkdwn("_em_")).toBe("`_`em`_`");
    expect(escapeSlackMrkdwn("~strike~")).toBe("`~`strike`~`");
    expect(escapeSlackMrkdwn("`code`")).toBe("\uFF40code\uFF40");
    expect(escapeSlackMrkdwn("`code`")).not.toContain("`");
  });

  it("escapes job update, kill-switch reason, and issue fields the same way", async () => {
    // source: security review of the 2026-10-12 export
    const job = sampleJob(maliciousTitle, "operator", "job_2");
    const updated = await captureSlack(() => notifyJobUpdate(job, "human rejected"));
    expect(updated).not.toContain("<!channel>");
    expect(updated).not.toContain("<https://");

    const state: KillSwitchState = {
      schema_version: 1,
      active: true,
      reason: maliciousTitle,
      since: "2026-10-12T12:00:00.000Z",
      set_by: "human",
    };
    const armed = await captureSlack(() => notifyKillSwitch(state));
    expect(armed).not.toContain("<!channel>");
    expect(armed).not.toContain("<https://");
    expect(armed).toContain(escapeSlackMrkdwn(maliciousTitle));

    const issue = await captureSlack(() =>
      notifyIssueDetected({ issueId: "id_<x>", title: maliciousTitle }),
    );
    expect(issue).not.toContain("<!channel>");
    expect(issue).not.toContain("<https://");
    expect(issue).not.toContain("id_<x>");
    expect(issue).toContain(escapeSlackMrkdwn("id_<x>"));
  });

  it("truncates plain_text to 150 characters and does not markup-escape it", () => {
    // source: security review of the 2026-10-12 export
    const raw = `<!channel> ${"x".repeat(180)}`;
    const plain = slackPlainText(raw);
    expect(plain.length).toBe(150);
    expect(plain).toBe(raw.slice(0, 150));
    expect(plain.startsWith("<!channel>")).toBe(true);
    expect(slackPlainText("short *title*")).toBe("short *title*");
  });
});
