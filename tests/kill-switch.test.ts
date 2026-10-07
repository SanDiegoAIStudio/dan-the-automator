import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli";
import { readKillSwitch, setKillSwitch } from "../src/kill-switch";

const runningAsRoot = typeof process.getuid === "function" && process.getuid() === 0;

describe("kill-switch fail-closed contract", () => {
  let previousDataDir: string | undefined;
  let dir: string;

  beforeEach(() => {
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
    if (previousDataDir === undefined) delete process.env["DAN_DATA_DIR"];
    else process.env["DAN_DATA_DIR"] = previousDataDir;
  });

  it("a missing file reads as fail-open and does not block", () => {
    // source: ENOENT is first boot and must stay fail-open
    const ks = readKillSwitch();
    expect(ks.mode).toBe("fail-open");
    expect(ks.blocksWork).toBe(false);
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

  it("a corrupt file in a read-only data folder still returns fail-closed without throwing", () => {
    // source: writing the corruption log threw, so a read crashed instead of failing closed
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
    expect(ks?.mode).toBe("fail-closed");
    expect(ks?.blocksWork).toBe(true);
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

  it("ks gate returns 0 and prints nothing when the switch does not block work", async () => {
    // source: hooks need a quiet zero exit while the switch is clear or missing
    const missing = await capture(() => runCli(["ks", "gate"]));
    expect(missing.code).toBe(0);
    expect(missing.stdout).toBe("");
    expect(missing.stderr).toBe("");

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

  it("ks gate returns 2 for a corrupt file", async () => {
    // source: a corrupt switch file must fail closed for hooks, exit 2
    writeFileSync(join(dir, "kill-switch.json"), "{not-json");
    const captured = await capture(() => runCli(["ks", "gate"]));
    expect(captured.code).toBe(2);
    expect(captured.stderr).toBe(
      "Kill-switch is armed (fail-closed): corruption. A person clears it with: dan ks off"
    );
  });

  it("ks on with no reason returns 1 and does not throw", async () => {
    // source: `ks on` with no reason crashed with a stack trace
    const captured = await capture(() => runCli(["ks", "on"]));
    expect(captured.code).toBe(1);
    expect(captured.stdout).toContain("a reason is required");
    expect(readKillSwitch().blocksWork).toBe(false);
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
    expect(captured.stdout.split("\n")[0]).toBe("dan-the-automator 0.2.0");
    expect(captured.stdout).not.toContain("dan dan-the-automator");
    expect(captured.stdout).toContain(
      "San Diego AI Studio / Luc Face. It proposes actions, and a person approves or rejects each one."
    );
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
    const past = new Date(Date.now() - 60 * 1000).toISOString();
    setKillSwitch({ active: true, reason: "short hold", setBy: "human", expiresAt: past });
    const ks = readKillSwitch();
    expect(ks.mode).toBe("clear");
    expect(ks.blocksWork).toBe(false);
    expect(ks.state.active).toBe(true);
    const captured = await capture(() => runCli(["ks", "gate"]));
    expect(captured.code).toBe(0);
    expect(captured.stdout).toBe("");
    expect(captured.stderr).toBe("");
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
