import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./config";
import { HeartbeatSchema, type Heartbeat } from "./types";

function heartbeatDir(): string {
  return join(dataDir(), "heartbeats");
}

function heartbeatPath(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(heartbeatDir(), `${safe}.json`);
}

export function writeHeartbeat(name: string, cadenceSeconds: number, at = new Date()): Heartbeat {
  mkdirSync(heartbeatDir(), { recursive: true });
  const beat: Heartbeat = {
    name,
    at: at.toISOString(),
    cadenceSeconds,
  };
  const parsed = HeartbeatSchema.parse(beat);
  writeFileSync(heartbeatPath(name), `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  return parsed;
}

export function isStale(beat: Heartbeat, now = Date.now()): boolean {
  const ageMs = now - Date.parse(beat.at);
  return ageMs > beat.cadenceSeconds * 2 * 1000;
}

export function listHeartbeats(now = Date.now()): {
  beats: Array<Heartbeat & { stale: boolean }>;
  staleCount: number;
} {
  mkdirSync(heartbeatDir(), { recursive: true });
  const files = readdirSync(heartbeatDir()).filter((f) => f.endsWith(".json"));
  const beats: Array<Heartbeat & { stale: boolean }> = [];

  for (const file of files) {
    const raw = readFileSync(join(heartbeatDir(), file), "utf8");
    const parsed = HeartbeatSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      continue;
    }
    beats.push({ ...parsed.data, stale: isStale(parsed.data, now) });
  }

  beats.sort((a, b) => a.name.localeCompare(b.name));
  return {
    beats,
    staleCount: beats.filter((b) => b.stale).length,
  };
}

export function clearHeartbeatsForTests(): void {
  mkdirSync(heartbeatDir(), { recursive: true });
  for (const file of readdirSync(heartbeatDir())) {
    if (file.endsWith(".json")) {
      unlinkSync(join(heartbeatDir(), file));
    }
  }
}
