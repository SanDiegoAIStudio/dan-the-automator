import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { dataDir, dataDirLogLine } from "./config";
import { DEFAULT_KILL_SWITCH, KillSwitchSchema, type KillSwitchState } from "./types";

export interface KillSwitchRead {
  state: KillSwitchState;
  blocksWork: boolean;
  mode: "fail-closed" | "armed" | "clear" | "expired";
  path: string;
  warning?: string;
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

function failClosed(path: string, reason: "corruption" | "unreadable" | "state file missing"): KillSwitchRead {
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

type Loaded =
  | { kind: "missing" }
  | { kind: "unreadable" }
  | { kind: "corrupt" }
  | { kind: "state"; state: KillSwitchState };

function isExpired(state: KillSwitchState, now = Date.now()): boolean {
  return state.active && state.expires_at !== undefined && Date.parse(state.expires_at) <= now;
}

function toRead(loaded: Loaded, path: string): KillSwitchRead {
  if (loaded.kind === "missing") return failClosed(path, "state file missing");
  if (loaded.kind === "unreadable") return failClosed(path, "unreadable");
  if (loaded.kind === "corrupt") return failClosed(path, "corruption");
  if (isExpired(loaded.state)) {
    return {
      state: loaded.state,
      blocksWork: false,
      mode: "expired",
      path,
    };
  }
  return {
    state: loaded.state,
    blocksWork: loaded.state.active,
    mode: loaded.state.active ? "armed" : "clear",
    path,
  };
}

function loadState(recordFailure: boolean): Loaded {
  let raw: string;
  try {
    raw = readFileSync(killSwitchPath(), "utf8");
  } catch (err: unknown) {
    if (errorCode(err) === "ENOENT") return { kind: "missing" };
    if (recordFailure) {
      const message = err instanceof Error ? err.message : String(err);
      appendCorruption(`unreadable ${message}`);
    }
    return { kind: "unreadable" };
  }

  try {
    return { kind: "state", state: KillSwitchSchema.parse(JSON.parse(raw)) };
  } catch (err: unknown) {
    if (recordFailure) {
      const message = err instanceof Error ? err.message : String(err);
      appendCorruption(`parse-failure ${message}`);
    }
    return { kind: "corrupt" };
  }
}

/**
 * Arm and clear replace the record just read. schema_version stays with
 * that record when the file parsed, and the requested fields are the change.
 */
function applyRequested(seen: Loaded, requested: KillSwitchState): KillSwitchState {
  const base = seen.kind === "state" ? seen.state : requested;
  const applied: KillSwitchState = {
    schema_version: base.schema_version,
    active: requested.active,
    reason: requested.reason,
    since: requested.since,
    set_by: requested.set_by,
  };
  if (requested.expires_at !== undefined) applied.expires_at = requested.expires_at;
  return applied;
}

let dataDirAnnounced = false;

/**
 * `dan ks status` prints the folder it is reading so arming from another
 * working directory is visible. `dan ks gate` stays quiet.
 */
function announceDataDirForStatus(): void {
  if (dataDirAnnounced || !isKsStatusArgv()) return;
  dataDirAnnounced = true;
  console.log(dataDirLogLine());
}

function isKsStatusArgv(): boolean {
  const args = process.argv;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "ks") continue;
    const sub = args[index + 1];
    return sub === undefined || sub === "status";
  }
  return false;
}

function isKsGateArgv(): boolean {
  const args = process.argv;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "ks") continue;
    return args[index + 1] === "gate";
  }
  return false;
}

function isCliProcess(): boolean {
  return process.argv.some((arg) => {
    if (arg === "dan") return true;
    const slash = Math.max(arg.lastIndexOf("/"), arg.lastIndexOf("\\"));
    const base = slash === -1 ? arg : arg.slice(slash + 1);
    return base === "cli.ts";
  });
}

function writeStateFile(filePath: string, contents: string): void {
  ensureDir(filePath);
  const tmp = `${filePath}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, contents, { encoding: "utf8" });
  } catch {
    throw new Error(`could not write ${basename(filePath)}`);
  }
  try {
    renameSync(tmp, filePath);
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      // The state file was not replaced. A leftover temp is secondary.
    }
    throw new Error(`could not write ${basename(filePath)}`);
  }
}

function appendAudit(auditLine: string): string | undefined {
  try {
    appendLog(auditLogPath(), auditLine);
    return undefined;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Dan] audit log was not written: kill-switch.log (${message})`);
    return "audit log was not written: kill-switch.log";
  }
}

/**
 * Layer 7 kill switch.
 * A missing, unreadable, or corrupt file reads as armed.
 * Only `dan init` writes a clear file, and only when none exists.
 * An armed file past expires_at reads as clear. The file is left as it is.
 * Status then reports mode "expired".
 * The state file is a temp file in the same folder, then rename.
 * The audit line is appended after that rename. A failed append is logged
 * and returned as a warning. The written state stays as it is.
 */
export function readKillSwitch(): KillSwitchRead {
  announceDataDirForStatus();
  return judge(killSwitchPath());
}

function judge(path: string): KillSwitchRead {
  return toRead(loadState(true), path);
}

export function writeKillSwitch(next: KillSwitchState): KillSwitchRead {
  const path = killSwitchPath();
  const requested = KillSwitchSchema.parse(next);
  const seen = loadState(false);
  const applied = applyRequested(seen, requested);
  const auditLine = `${new Date().toISOString()} set_by=${applied.set_by} active=${applied.active} reason=${JSON.stringify(applied.reason)}`;
  writeStateFile(path, `${JSON.stringify(applied, null, 2)}\n`);
  const warning = appendAudit(auditLine);
  const read = judge(path);
  if (warning === undefined) return read;
  return { ...read, warning: read.warning ?? warning };
}

type ClearListener = () => void;
const clearListeners: ClearListener[] = [];
let notifyingClear = false;

function notifyCleared(): void {
  if (notifyingClear) return;
  notifyingClear = true;
  try {
    for (const listener of clearListeners) {
      listener();
    }
  } finally {
    notifyingClear = false;
  }
}

export function onKillSwitchCleared(listener: ClearListener): void {
  clearListeners.push(listener);
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
  const written = writeKillSwitch({
    schema_version: 1,
    active: params.active,
    reason: params.active ? params.reason : "",
    since: params.active ? new Date().toISOString() : null,
    set_by: params.setBy ?? "human",
    ...(params.expiresAt ? { expires_at: params.expiresAt } : {}),
  });
  if (!params.active) notifyCleared();
  return written;
}

export type KillSwitchInit =
  | { status: "did"; path: string; read: KillSwitchRead }
  | { status: "had_no_work"; path: string; read: KillSwitchRead }
  | { status: "could_not"; path: string };

export function initKillSwitch(): KillSwitchInit {
  const path = killSwitchPath();
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err: unknown) {
    if (errorCode(err) !== "ENOENT") {
      return { status: "could_not", path };
    }
    const read = setKillSwitch({ active: false, reason: "", setBy: "human" });
    return { status: "did", path, read };
  }

  try {
    KillSwitchSchema.parse(JSON.parse(raw));
  } catch {
    return { status: "could_not", path };
  }
  return { status: "had_no_work", path, read: readKillSwitch() };
}

export function resetKillSwitchFileForTests(): void {
  writeKillSwitch(DEFAULT_KILL_SWITCH);
}

// The dan process prints the data dir on start. ks gate stays quiet.
if (isCliProcess() && !isKsGateArgv()) {
  try {
    console.log(dataDirLogLine());
    dataDirAnnounced = true;
  } catch {
    // An empty DAN_DATA_DIR is reported by the command.
  }
}
