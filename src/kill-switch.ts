import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataDir } from "./config";
import { DEFAULT_KILL_SWITCH, KillSwitchSchema, type KillSwitchState } from "./types";

export interface KillSwitchRead {
  state: KillSwitchState;
  blocksWork: boolean;
  mode: "fail-open" | "fail-closed" | "armed" | "clear";
  path: string;
}

function killSwitchPath(): string {
  return join(dataDir(), "kill-switch.json");
}

function corruptionLogPath(): string {
  return join(dataDir(), "kill-switch-corruption.log");
}

function auditLogPath(): string {
  return join(dataDir(), "kill-switch.log");
}

function ensureDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}

function appendLog(filePath: string, line: string): void {
  ensureDir(filePath);
  writeFileSync(filePath, `${line}\n`, { flag: "a" });
}

function errorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !("code" in err)) return undefined;
  const code = err.code;
  return typeof code === "string" ? code : undefined;
}

function textAfterTimestamp(line: string): string {
  const space = line.indexOf(" ");
  if (space === -1) return "";
  return line.slice(space + 1);
}

function lastCorruptionLine(): string | undefined {
  try {
    const raw = readFileSync(corruptionLogPath(), "utf8");
    const lines = raw.split("\n").filter((line) => line.length > 0);
    return lines[lines.length - 1];
  } catch {
    return undefined;
  }
}

function killSwitchMtime(): string {
  try {
    return String(Math.floor(statSync(killSwitchPath()).mtimeMs));
  } catch {
    return "unknown";
  }
}

function appendCorruption(failureText: string): void {
  try {
    const recorded = `${failureText} mtime=${killSwitchMtime()}`;
    const last = lastCorruptionLine();
    if (last !== undefined && textAfterTimestamp(last) === recorded) return;
    appendLog(corruptionLogPath(), `${new Date().toISOString()} ${recorded}`);
  } catch {
    // An unwritable data folder still returns the fail-closed result.
  }
}

function failClosed(path: string, reason: "corruption" | "unreadable"): KillSwitchRead {
  return {
    state: {
      ...DEFAULT_KILL_SWITCH,
      active: true,
      reason,
      since: new Date().toISOString(),
      set_by: "agent",
    },
    blocksWork: true,
    mode: "fail-closed",
    path,
  };
}

function atomicWrite(filePath: string, contents: string): void {
  ensureDir(filePath);
  const tmp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmp, contents, { encoding: "utf8" });
  renameSync(tmp, filePath);
}

/**
 * THE-SYSTEM Layer 7 contract:
 * - file missing (ENOENT) → fail-open (first boot)
 * - unreadable or parse failure → fail-closed (treat as active)
 * - active=true → every system-work path must stop
 */
export function readKillSwitch(): KillSwitchRead {
  const path = killSwitchPath();
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err: unknown) {
    if (errorCode(err) === "ENOENT") {
      return {
        state: DEFAULT_KILL_SWITCH,
        blocksWork: false,
        mode: "fail-open",
        path,
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    appendCorruption(`unreadable ${message}`);
    return failClosed(path, "unreadable");
  }

  try {
    const parsed = KillSwitchSchema.parse(JSON.parse(raw));
    const expired = parsed.expires_at ? Date.parse(parsed.expires_at) <= Date.now() : false;
    const active = parsed.active && !expired;
    return {
      state: parsed,
      blocksWork: active,
      mode: active ? "armed" : "clear",
      path,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    appendCorruption(`parse-failure ${message}`);
    return failClosed(path, "corruption");
  }
}

export function writeKillSwitch(next: KillSwitchState): KillSwitchRead {
  const path = killSwitchPath();
  const parsed = KillSwitchSchema.parse(next);
  atomicWrite(path, `${JSON.stringify(parsed, null, 2)}\n`);
  appendLog(
    auditLogPath(),
    `${new Date().toISOString()} set_by=${parsed.set_by} active=${parsed.active} reason=${JSON.stringify(parsed.reason)}`
  );
  return readKillSwitch();
}

export function setKillSwitch(params: {
  active: boolean;
  reason: string;
  setBy?: "human" | "agent";
  expiresAt?: string;
}): KillSwitchRead {
  if (params.active && params.reason.trim().length === 0) {
    throw new Error("kill-switch on requires a reason");
  }
  return writeKillSwitch({
    schema_version: 1,
    active: params.active,
    reason: params.active ? params.reason : "",
    since: params.active ? new Date().toISOString() : null,
    set_by: params.setBy ?? "human",
    ...(params.expiresAt ? { expires_at: params.expiresAt } : {}),
  });
}

export function resetKillSwitchFileForTests(): void {
  const path = killSwitchPath();
  try {
    unlinkSync(path);
  } catch {
    // missing is the fail-open first-boot state
  }
}
