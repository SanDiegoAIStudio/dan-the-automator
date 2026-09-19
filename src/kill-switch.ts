import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
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

function atomicWrite(filePath: string, contents: string): void {
  ensureDir(filePath);
  const tmp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmp, contents, { encoding: "utf8" });
  renameSync(tmp, filePath);
}

/**
 * THE-SYSTEM Layer 7 contract:
 * - file missing → fail-open (first boot)
 * - parse failure → fail-closed (treat as active)
 * - active=true → every system-work path must stop
 */
export function readKillSwitch(): KillSwitchRead {
  const path = killSwitchPath();
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return {
      state: DEFAULT_KILL_SWITCH,
      blocksWork: false,
      mode: "fail-open",
      path,
    };
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
    appendLog(corruptionLogPath(), `${new Date().toISOString()} parse-failure ${message}`);
    return {
      state: {
        ...DEFAULT_KILL_SWITCH,
        active: true,
        reason: "corruption",
        since: new Date().toISOString(),
        set_by: "agent",
      },
      blocksWork: true,
      mode: "fail-closed",
      path,
    };
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
