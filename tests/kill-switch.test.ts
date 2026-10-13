import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gateExitCode, runCli } from "../src/cli";
import { SERVICE_NAME, VERSION } from "../src/config";
import { readKillSwitch, setKillSwitch } from "../src/kill-switch";
import { KillSwitchSchema } from "../src/types";

const runningAsRoot = typeof process.getuid === "function" && process.getuid() === 0;

describe("kill-switch fail-closed contract", () => {
  let previousDataDir: string | undefined;
  let dir: string;

  beforeEach(() => {
    delete process.env["SLACK_WEBHOOK_URL"];
    previousDataDir = process.env["DAN_DATA_DIR"];
    dir = mkdtempSync(join(tmpdir(), "dan-ks-"));
    process.env["DAN_DATA_DIR"] = dir;
  });

  afterEach(() => {
    try {
      chmodSync(dir, 0o755);
    } catch {
      // the temp dir is already writable, or this process cannot chmod it
    }
    const file = join(dir, "kill-switch.json");
    if (existsSync(file)) {
      try {
        chmodSync(file, 0o644);
      } catch {
        // a mode 000 switch, or this process cannot chmod it
      }
    }
    rmSync(dir, { recursive: true, force: true });
    if (previousDataDir === undefined) delete process.env["DAN_DATA_DIR"];
    else process.env["DAN_DATA_DIR"] = previousDataDir;
  });

  it("a missing file reads as armed with reason state file missing", () => {
    // source: code review of the 2026-10-12 export
    const ks = readKillSwitch();
    expect(ks.mode).toBe("fail-closed");
    expect(ks.blocksWork).toBe(true);
    expect(ks.state.reason).toBe("state file missing");
    expect(ks.state.active).toBe(true);
    expect(existsSync(join(dir, "kill-switch-corruption.log"))).toBe(false);
  });

  it.skipIf(runningAsRoot)("a file with mode 000 reads as fail-closed and blocks", () => {
    // source: permission denied was treated as a missing file and failed open
    const file = join(dir, "kill-switch.json");
    writeFileSync(file, "{}\n");
    chmodSync(file, 0o000);
    const ks = readKillSwitch();
    expect(ks.mode).toBe("fail-closed");
    expect(ks.blocksWork).toBe(true);
    expect(ks.state.reason).toBe("unreadable");
  });

  it("a folder named kill-switch.json reads as fail-closed and blocks", () => {
    // source: a directory in the file's place was treated as a missing file and failed open
    mkdirSync(join(dir, "kill-switch.json"));
    const ks = readKillSwitch();
    expect(ks.mode).toBe("fail-closed");
    expect(ks.blocksWork).toBe(true);
    expect(ks.state.reason).toBe("unreadable");
  });

  it("a corrupt file in a read-only data folder stays armed without throwing", () => {
    // source: writing the corruption log threw, so a read crashed instead of failing closed
    // source: security review of 6b02ecb
    // source: simplification round, 2026-10-13
    writeFileSync(join(dir, "kill-switch.json"), "{not-json");
    chmodSync(dir, 0o555);
    let threw = false;
    let ks: ReturnType<typeof readKillSwitch> | undefined;
    try {
      ks = readKillSwitch();
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(ks?.blocksWork).toBe(true);
    expect(ks?.mode).toBe("fail-closed");
    expect(ks?.state.reason).toBe("corruption");
  });

  it("reading the same corrupt file five times leaves exactly one line in the corruption log", () => {
    // source: every read appended a new corruption line for the same broken file
    writeFileSync(join(dir, "kill-switch.json"), "{not-json");
    for (let i = 0; i < 5; i += 1) {
      const ks = readKillSwitch();
      expect(ks.mode).toBe("fail-closed");
      expect(ks.state.reason).toBe("corruption");
    }
    const raw = readFileSync(join(dir, "kill-switch-corruption.log"), "utf8");
    const lines = raw.split("\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(1);
  });

  it("the same corruption on a rewritten file is logged again", () => {
    // source: the dedupe hid a recurrence of the same corruption after the file was fixed
    const file = join(dir, "kill-switch.json");
    const corrupt = "{not-json";
    writeFileSync(file, corrupt);
    readKillSwitch();
    readKillSwitch();
    writeFileSync(file, corrupt);
    const later = new Date(statSync(file).mtimeMs + 2000);
    utimesSync(file, later, later);
    readKillSwitch();
    readKillSwitch();
    const raw = readFileSync(join(dir, "kill-switch-corruption.log"), "utf8");
    const lines = raw.split("\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(2);
  });

  it("ks gate returns 2 when the state file is missing and tells you to run dan init", async () => {
    // source: code review of the 2026-10-12 export
    const missing = await capture(() => runCli(["ks", "gate"]));
    expect(missing.code).toBe(2);
    expect(missing.stdout).toBe("");
    expect(missing.stderr).toBe(
      "Kill-switch is armed (fail-closed): state file missing. Run dan init.",
    );
  });

  it("ks gate returns 0 and prints nothing when the switch does not block work", async () => {
    // source: code review of the 2026-10-12 export
    setKillSwitch({ active: false, reason: "", setBy: "human" });
    const clear = await capture(() => runCli(["ks", "gate"]));
    expect(clear.code).toBe(0);
    expect(clear.stdout).toBe("");
    expect(clear.stderr).toBe("");
  });

  it("ks gate returns 2 when armed and writes the reason to stderr", async () => {
    // source: an armed switch must stop a hook with the reason and exit 2
    setKillSwitch({ active: true, reason: "revenue week", setBy: "human" });
    const captured = await capture(() => runCli(["ks", "gate"]));
    expect(captured.code).toBe(2);
    expect(captured.stdout).toBe("");
    expect(captured.stderr).toBe(
      "Kill-switch is armed (armed): revenue week. A person clears it with: dan ks off"
    );
  });

  it("ks gate returns 2 for a corrupt file and names the path", async () => {
    // source: code review of the 2026-10-12 export
    const file = join(dir, "kill-switch.json");
    writeFileSync(file, "{not-json");
    const captured = await capture(() => runCli(["ks", "gate"]));
    expect(captured.code).toBe(2);
    expect(captured.stderr).toBe(
      `Kill-switch is armed (fail-closed): corruption. Fix or remove ${file}, then run dan init.`,
    );
  });

  it("ks gate names the path when the state file is unreadable", async () => {
    // source: code review of the 2026-10-12 export
    const file = join(dir, "kill-switch.json");
    mkdirSync(file);
    const captured = await capture(() => runCli(["ks", "gate"]));
    expect(captured.code).toBe(2);
    expect(captured.stderr).toBe(
      `Kill-switch is armed (fail-closed): unreadable. Fix or remove ${file}, then run dan init.`,
    );
  });

  it("ks gate returns 2 when reading the switch throws", () => {
    // source: a thrown read inside ks gate became exit 1, which a hook treats as not blocking
    let threw = false;
    let code = 0;
    const captured = captureSync(() => {
      try {
        code = gateExitCode(() => {
          throw new Error("disk gone");
        });
      } catch {
        threw = true;
      }
    });
    expect(threw).toBe(false);
    expect(code).toBe(2);
    expect(captured.stderr).toBe("Kill-switch could not be read (disk gone). Treating it as armed.");
  });

  it("ks on with no reason returns 1 and does not throw", async () => {
    // source: code review of the 2026-10-12 export
    const captured = await capture(() => runCli(["ks", "on"]));
    expect(captured.code).toBe(1);
    expect(captured.stdout).toContain("a reason is required");
    expect(existsSync(join(dir, "kill-switch.json"))).toBe(false);
    expect(readKillSwitch().state.reason).toBe("state file missing");
  });

  it("a command that throws inside runCli returns 1 with Error: on stderr", async () => {
    // source: runCli let a thrown command print a stack trace
    const blocker = join(dir, "not-a-directory");
    writeFileSync(blocker, "x");
    process.env["DAN_DATA_DIR"] = join(blocker, "nested");
    let rejected = false;
    const kept: { error: unknown } = { error: undefined };
    let captured: { code: number; stdout: string; stderr: string } | undefined;
    try {
      captured = await capture(() => runCli(["ks", "on", "because"]));
    } catch (error: unknown) {
      rejected = true;
      kept.error = error;
    }
    expect(rejected).toBe(false);
    expect(captured?.code).toBe(1);
    expect(captured?.stderr).toContain("Error:");
    expect(captured?.stderr).not.toContain("    at ");
  });

  it("the usage text has no long dash and does not contain A human gates.", async () => {
    // source: usage opened with an em dash and the slogan "A human gates."
    const source = readFileSync(join(import.meta.dir, "../src/cli.ts"), "utf8");
    expect(source.startsWith("#!/usr/bin/env bun\n")).toBe(true);
    expect(source).not.toContain("\u2014");
    expect(source).not.toContain("\u2013");
    const captured = await capture(() => runCli(["help"]));
    expect(captured.code).toBe(0);
    expect(captured.stdout.split("\n")[0]).toBe(`${SERVICE_NAME} ${VERSION}`);
    expect(captured.stdout).not.toContain("dan dan-the-automator");
    expect(captured.stdout).toContain(
      "San Diego AI Studio / Luc Face. It proposes actions, and a person approves or rejects each one."
    );
    expect(captured.stdout).toContain("  dan init");
    expect(captured.stdout).toContain("  dan ks gate");
    expect(captured.stdout).not.toContain("A human gates.");
    expect(captured.stdout).not.toContain("\u2014");
    expect(captured.stdout).not.toContain("\u2013");
  });

  it("ks with an unknown subcommand returns 1 and lists every subcommand", async () => {
    // source: the ks usage line left out the gate subcommand
    const captured = await capture(() => runCli(["ks", "bogus"]));
    expect(captured.code).toBe(1);
    expect(captured.stdout).toBe("ks status | ks gate | ks on <reason> | ks off");
    expect(captured.stderr).toBe("");
  });

  it("an armed switch whose expires_at has passed reads as clear and lets the gate through", async () => {
    // source: no test covered expiry, so a fault that kept an expired switch armed passed the suite
    // source: simplification round, 2026-10-13
    const past = new Date(Date.now() - 60 * 1000).toISOString();
    setKillSwitch({ active: true, reason: "short hold", setBy: "human", expiresAt: past });
    const file = join(dir, "kill-switch.json");
    const before = readFileSync(file, "utf8");
    const ks = readKillSwitch();
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(ks.mode).toBe("expired");
    expect(ks.blocksWork).toBe(false);
    expect(ks.state.active).toBe(true);
    const status = await capture(() => runCli(["ks", "status"]));
    expect(status.code).toBe(0);
    expect(status.stdout).toContain('"mode": "expired"');
    expect(readFileSync(file, "utf8")).toBe(before);
    const captured = await capture(() => runCli(["ks", "gate"]));
    expect(captured.code).toBe(0);
    expect(captured.stdout).toBe("");
    expect(captured.stderr).toBe("");
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("an armed switch whose expires_at is still ahead blocks", async () => {
    // source: expiry must not clear a switch before its time
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    setKillSwitch({ active: true, reason: "short hold", setBy: "human", expiresAt: future });
    const ks = readKillSwitch();
    expect(ks.mode).toBe("armed");
    expect(ks.blocksWork).toBe(true);
    const captured = await capture(() => runCli(["ks", "gate"]));
    expect(captured.code).toBe(2);
  });

  it("dan init writes a clear state file when none exists and leaves a present file alone", async () => {
    // source: code review of the 2026-10-12 export
    // source: second code review of the 2026-10-12 export
    const file = join(dir, "kill-switch.json");
    expect(existsSync(file)).toBe(false);
    const first = await capture(() => runCli(["init"]));
    expect(first.code).toBe(0);
    expect(first.stdout).toContain('"status": "did"');
    const created = readKillSwitch();
    expect(created.mode).toBe("clear");
    expect(created.blocksWork).toBe(false);
    expect(created.state.active).toBe(false);

    const second = await capture(() => runCli(["init"]));
    expect(second.code).toBe(0);
    expect(second.stdout).toContain('"status": "had_no_work"');
    expect(second.stdout).toContain('"mode": "clear"');
    expect(readKillSwitch().blocksWork).toBe(false);

    setKillSwitch({ active: true, reason: "keep this", setBy: "human" });
    const armed = await capture(() => runCli(["init"]));
    expect(armed.code).toBe(0);
    expect(armed.stdout).toContain('"status": "had_no_work"');
    expect(armed.stdout).toContain('"mode": "armed"');
    expect(readKillSwitch().state.reason).toBe("keep this");
    expect(readKillSwitch().state.active).toBe(true);

    const corrupt = "{not-json";
    writeFileSync(file, corrupt);
    const third = await capture(() => runCli(["init"]));
    expect(third.code).toBe(1);
    expect(third.stderr).toContain(`could_not ${file}`);
    expect(third.stderr).toContain("dan init");
    expect(readFileSync(file, "utf8")).toBe(corrupt);
  });

  it("a showcase start does not write a clear state file", () => {
    // source: code review of the 2026-10-12 export
    // source: second code review of the 2026-10-12 export
    const file = join(dir, "kill-switch.json");
    const quiet = bootServer(dir, {});
    expect(quiet.code, quiet.text).toBe(0);
    expect(existsSync(file)).toBe(false);

    const showcase = bootServer(dir, { DAN_LOCAL_SHOWCASE: "1" });
    expect(showcase.code, showcase.text).toBe(0);
    expect(existsSync(file)).toBe(false);

    writeFileSync(
      file,
      `${JSON.stringify({
        schema_version: 1,
        active: true,
        reason: "keep this",
        since: "2026-10-12T00:00:00.000Z",
        set_by: "human",
      })}\n`,
    );
    const kept = bootServer(dir, { DAN_LOCAL_SHOWCASE: "1" });
    expect(kept.code, kept.text).toBe(0);
    const still = KillSwitchSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    expect(still.active).toBe(true);
    expect(still.reason).toBe("keep this");
  });

  it("an expires_at that is not a date reads as fail-closed", () => {
    // source: a hand-edited expires_at that cannot be read must not clear the switch
    writeFileSync(
      join(dir, "kill-switch.json"),
      `${JSON.stringify({
        schema_version: 1,
        active: true,
        reason: "hand edit",
        since: null,
        set_by: "human",
        expires_at: "tomorrow",
      })}\n`,
    );
    const ks = readKillSwitch();
    expect(ks.mode).toBe("fail-closed");
    expect(ks.blocksWork).toBe(true);
    expect(ks.state.reason).toBe("corruption");
  });
});

function bootServer(dir: string, extra: Record<string, string>): { code: number; text: string } {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "USER"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env["DAN_DATA_DIR"] = dir;
  for (const [key, value] of Object.entries(extra)) env[key] = value;
  const result = Bun.spawnSync(["bun", "--no-env-file", "-e", "await import('./src/index.ts'); process.exit(0)"], {
    cwd: join(import.meta.dir, ".."),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode ?? 1,
    text: `${result.stdout.toString()}\n${result.stderr.toString()}`,
  };
}

function captureSync(run: () => void): { stdout: string; stderr: string } {
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
    run();
    return { stdout: out.join("\n"), stderr: err.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
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
