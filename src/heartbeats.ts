import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./config";
import { HeartbeatSchema, type Heartbeat } from "./types";

export interface UnreadableHeartbeat {
  name: string;
  state: "could_not";
  reason: string;
}

export type ListedHeartbeat = (Heartbeat & { stale: boolean }) | UnreadableHeartbeat;

function heartbeatDir(): string {
  return join(dataDir(), "heartbeats");
}

function heartbeatPath(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(heartbeatDir(), `${safe}.json`);
}

function reasonText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const cleaned = message.replace(/[\u0000-\u001F\u007F]/g, " ").slice(0, 200);
  if (cleaned.length === 0 || cleaned.includes("/") || cleaned.includes("\\")) return "unreadable";
  return cleaned;
}

function fileStem(file: string): string {
  return file.endsWith(".json") ? file.slice(0, -".json".length) : file;
}

function atomicWrite(filePath: string, contents: string): void {
  const tmp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmp, contents, { encoding: "utf8" });
  renameSync(tmp, filePath);
}

export function writeHeartbeat(name: string, cadenceSeconds: number, at = new Date()): Heartbeat {
  mkdirSync(heartbeatDir(), { recursive: true });
  const beat: Heartbeat = {
    name,
    at: at.toISOString(),
    cadenceSeconds,
  };
  const parsed = HeartbeatSchema.parse(beat);
  atomicWrite(heartbeatPath(name), `${JSON.stringify(parsed, null, 2)}\n`);
  return parsed;
}

export function isStale(beat: Heartbeat, now = Date.now()): boolean {
  const ageMs = now - Date.parse(beat.at);
  return ageMs > beat.cadenceSeconds * 2 * 1000;
}

function countsAsStale(beat: ListedHeartbeat): boolean {
  if ("state" in beat && beat.state === "could_not") return true;
  return "stale" in beat && beat.stale;
}

function readOne(file: string, now: number): ListedHeartbeat {
  const name = fileStem(file);
  let raw: string;
  try {
    raw = readFileSync(join(heartbeatDir(), file), "utf8");
  } catch (err: unknown) {
    return { name, state: "could_not", reason: reasonText(err) };
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch (err: unknown) {
    return { name, state: "could_not", reason: reasonText(err) };
  }

  const parsed = HeartbeatSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const reason = issue ? reasonText(new Error(issue.message)) : "invalid heartbeat";
    return { name, state: "could_not", reason };
  }
  return { ...parsed.data, stale: isStale(parsed.data, now) };
}

export function listHeartbeats(now = Date.now()): {
  beats: ListedHeartbeat[];
  staleCount: number;
} {
  try {
    mkdirSync(heartbeatDir(), { recursive: true });
    const files = readdirSync(heartbeatDir()).filter((file) => file.endsWith(".json"));
    const beats = files.map((file) => readOne(file, now));
    beats.sort((a, b) => a.name.localeCompare(b.name));
    return {
      beats,
      staleCount: beats.filter((beat) => countsAsStale(beat)).length,
    };
  } catch (err: unknown) {
    return {
      beats: [{ name: "heartbeats", state: "could_not", reason: reasonText(err) }],
      staleCount: 1,
    };
  }
}

export function clearHeartbeatsForTests(): void {
  mkdirSync(heartbeatDir(), { recursive: true });
  for (const file of readdirSync(heartbeatDir())) {
    if (file.endsWith(".json") || file.endsWith(".tmp")) {
      rmSync(join(heartbeatDir(), file), { recursive: true, force: true });
    }
  }
}
