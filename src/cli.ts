#!/usr/bin/env bun
import { SERVICE_NAME, VERSION, controlToken, serverPort } from "./config";
import { listHeartbeats, writeHeartbeat } from "./heartbeats";
import { initKillSwitch, readKillSwitch, setKillSwitch, type KillSwitchRead } from "./kill-switch";
import { SignalSchema, signalLimitError, type SignalKindType } from "./types";

const KINDS = new Set<SignalKindType>(["error", "heartbeat", "revenue", "content", "ops", "manual"]);
const SERVER_DOWN_LINE = "No server is answering on 127.0.0.1. Start it with bun dev.";

function print(data: unknown): void {
  if (typeof data === "string") {
    console.log(data);
    return;
  }
  console.log(JSON.stringify(data, null, 2));
}

function usage(): string {
  return `${SERVICE_NAME} ${VERSION}
San Diego AI Studio / Luc Face. It proposes actions, and a person approves or rejects each one.

  dan init
  dan health
  dan os
  dan ks status
  dan ks gate
  dan ks on <reason>
  dan ks off
  dan heartbeat <name> [--cadence 3600]
  dan heartbeats
  dan ingest --title <text> [--kind error|heartbeat|revenue|content|ops|manual] [--source operator] [--file path] [--ref id]
  dan jobs
  dan show <jobId>
  dan approve <jobId>
  dan reject <jobId> [--reason text]
`;
}

function flag(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  if (idx === -1) return undefined;
  return argv[idx + 1];
}

function controlFailureLine(status: number): string | undefined {
  if (status === 401) return "wrong or missing control token";
  if (status === 503) return "server has no token configured";
  return undefined;
}

async function serverExchange(
  path: string,
  method: string,
  body: string | undefined,
  nameAuthFailure: boolean,
): Promise<{ ok: true; body: unknown } | { ok: false; code: number }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = controlToken();
  if (token !== undefined) headers["Authorization"] = `Bearer ${token}`;
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${serverPort()}${path}`, { method, headers, body });
  } catch {
    console.error(SERVER_DOWN_LINE);
    return { ok: false, code: 1 };
  }
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text.length === 0 ? {} : JSON.parse(text);
  } catch {
    print("request failed");
    return { ok: false, code: 1 };
  }
  if (!response.ok) {
    const named = nameAuthFailure ? controlFailureLine(response.status) : undefined;
    print(named ?? errorMessage(parsed) ?? "request failed");
    return { ok: false, code: 1 };
  }
  return { ok: true, body: parsed };
}

async function serverJob(path: string, method: string, body?: string): Promise<number> {
  const result = await serverExchange(path, method, body, false);
  if (!result.ok) return result.code;
  print(jobPayload(result.body));
  return 0;
}

function jobsPayload(body: unknown): unknown[] | undefined {
  if (typeof body !== "object" || body === null || !("jobs" in body)) return undefined;
  const jobs = body.jobs;
  return Array.isArray(jobs) ? jobs : undefined;
}

function healthQueue(body: unknown): Record<string, number> | undefined {
  if (typeof body !== "object" || body === null || !("queue" in body)) return undefined;
  const queue = body.queue;
  if (typeof queue !== "object" || queue === null || Array.isArray(queue)) return undefined;
  const counts: Record<string, number> = {};
  for (const [key, value] of Object.entries(queue)) {
    if (typeof value !== "number") return undefined;
    counts[key] = value;
  }
  return counts;
}

function errorMessage(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null || !("error" in body)) return undefined;
  const error = body.error;
  return typeof error === "string" ? error : undefined;
}

function jobPayload(body: unknown): unknown {
  if (typeof body === "object" && body !== null && "job" in body) return body.job;
  return body;
}

export function gateExitCode(read: () => KillSwitchRead = readKillSwitch): number {
  let ks: KillSwitchRead;
  try {
    ks = read();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Kill-switch could not be read (${message}). Treating it as armed.`);
    return 2;
  }
  if (!ks.blocksWork) return 0;
  console.error(killSwitchStderr(ks));
  return 2;
}

function killSwitchView(ks: KillSwitchRead): KillSwitchRead["state"] & {
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

function killSwitchStderr(ks: KillSwitchRead): string {
  if (ks.mode === "fail-closed" && ks.state.reason === "state file missing") {
    return "Kill-switch is armed (fail-closed): state file missing. Run dan init.";
  }
  if (ks.mode === "fail-closed" && (ks.state.reason === "corruption" || ks.state.reason === "unreadable")) {
    return `Kill-switch is armed (${ks.mode}): ${ks.state.reason}. Fix or remove ${ks.path}, then run dan init.`;
  }
  return `Kill-switch is armed (${ks.mode}): ${ks.state.reason}. A person clears it with: dan ks off`;
}

export async function runCli(argv: string[]): Promise<number> {
  try {
    return await dispatch(argv);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
    return 1;
  }
}

async function dispatch(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;

  if (!cmd || cmd === "help" || cmd === "--help") {
    print(usage());
    return 0;
  }

  if (cmd === "init") {
    const result = initKillSwitch();
    if (result.status === "could_not") {
      console.error(`could_not ${result.path}. Fix or remove it, then run dan init.`);
      return 1;
    }
    print({
      status: result.status,
      path: result.path,
      ...result.read.state,
      blocksWork: result.read.blocksWork,
      mode: result.read.mode,
      ...(result.read.warning ? { warning: result.read.warning } : {}),
    });
    return 0;
  }

  if (cmd === "health") {
    const result = await serverExchange("/health", "GET", undefined, true);
    if (!result.ok) return result.code;
    const queue = healthQueue(result.body);
    if (!queue) {
      print("request failed");
      return 1;
    }
    const ks = readKillSwitch();
    const beats = listHeartbeats();
    print({
      service: SERVICE_NAME,
      version: VERSION,
      killSwitch: { active: ks.blocksWork, mode: ks.mode, reason: ks.state.reason },
      heartbeats: { total: beats.beats.length, stale: beats.staleCount },
      queue,
    });
    return 0;
  }

  if (cmd === "os") {
    const { PROPERTIES, LAYERS } = await import("./properties");
    print({ properties: PROPERTIES.map((p) => p.id), layers: LAYERS.map((l) => l.name) });
    return 0;
  }

  if (cmd === "ks") {
    const sub = rest[0];
    if (sub === "status" || !sub) {
      const ks = readKillSwitch();
      print({ ...ks.state, blocksWork: ks.blocksWork, mode: ks.mode });
      return 0;
    }
    if (sub === "gate") {
      return gateExitCode();
    }
    if (sub === "on") {
      const reason = rest.slice(1).join(" ").trim();
      if (reason.length === 0) {
        print("ks on <reason>: a reason is required");
        return 1;
      }
      const ks = setKillSwitch({ active: true, reason, setBy: "human" });
      print(killSwitchView(ks));
      return 0;
    }
    if (sub === "off") {
      const ks = setKillSwitch({ active: false, reason: "", setBy: "human" });
      print(killSwitchView(ks));
      return 0;
    }
    print("ks status | ks gate | ks on <reason> | ks off");
    return 1;
  }

  if (cmd === "heartbeat") {
    const name = rest[0];
    if (!name) {
      print("heartbeat <name> [--cadence 3600]");
      return 1;
    }
    const cadenceRaw = flag(rest, "--cadence");
    const cadence = cadenceRaw ? Number(cadenceRaw) : 3600;
    if (!Number.isFinite(cadence) || cadence <= 0) {
      print("cadence must be a positive number of seconds");
      return 1;
    }
    print(writeHeartbeat(name, cadence));
    return 0;
  }

  if (cmd === "heartbeats") {
    print(listHeartbeats());
    return 0;
  }

  if (cmd === "ingest") {
    const title = flag(rest, "--title");
    if (!title) {
      print("ingest --title <text> [--kind manual] [--source operator]");
      return 1;
    }
    const kindRaw = flag(rest, "--kind") ?? "manual";
    if (!KINDS.has(kindRaw as SignalKindType)) {
      print(`unknown kind: ${kindRaw}`);
      return 1;
    }
    const lineRaw = flag(rest, "--line");
    const parsed = SignalSchema.safeParse({
      source: flag(rest, "--source") ?? "operator",
      kind: kindRaw,
      title,
      body: flag(rest, "--body"),
      ref: flag(rest, "--ref"),
      file: flag(rest, "--file"),
      line: lineRaw ? Number(lineRaw) : undefined,
    });
    if (!parsed.success) {
      print(signalLimitError(parsed.error) ?? "invalid signal");
      return 1;
    }
    return serverJob("/signals", "POST", JSON.stringify(parsed.data));
  }

  if (cmd === "jobs") {
    const result = await serverExchange("/jobs", "GET", undefined, true);
    if (!result.ok) return result.code;
    const jobs = jobsPayload(result.body);
    if (!jobs) {
      print("request failed");
      return 1;
    }
    print(jobs);
    return 0;
  }

  if (cmd === "show") {
    const id = rest[0];
    if (!id) {
      print("show <jobId>");
      return 1;
    }
    const result = await serverExchange(`/jobs/${encodeURIComponent(id)}`, "GET", undefined, true);
    if (!result.ok) return result.code;
    print(jobPayload(result.body));
    return 0;
  }

  if (cmd === "approve" || cmd === "reject") {
    const id = rest[0];
    if (!id) {
      print(`${cmd} <jobId>`);
      return 1;
    }
    const reason = flag(rest, "--reason") ?? (cmd === "approve" ? "operator approved" : "operator rejected");
    if (cmd === "approve") return serverJob(`/jobs/${encodeURIComponent(id)}/approve`, "POST", "{}");
    return serverJob(`/jobs/${encodeURIComponent(id)}/reject`, "POST", JSON.stringify({ reason }));
  }

  print(usage());
  return 1;
}

if (import.meta.main) {
  const code = await runCli(process.argv.slice(2));
  process.exit(code);
}
