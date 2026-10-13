import { beforeEach, describe, expect, it } from "bun:test";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);

function gitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (typeof value === "string" && !name.startsWith("GIT_")) {
      env[name] = value;
    }
  }
  return env;
}

function isLockFile(path: string): boolean {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return (
    base === "bun.lock" ||
    base === "bun.lockb" ||
    base === "package-lock.json" ||
    base === "yarn.lock" ||
    base === "pnpm-lock.yaml" ||
    base.endsWith(".lock")
  );
}

function gitMissingReason(): string | undefined {
  if (!existsSync(join(REPO_ROOT, ".git"))) return "skip: .git folder is absent";
  try {
    const result = Bun.spawnSync(["git", "--version"], {
      cwd: REPO_ROOT,
      env: gitEnv(),
      stdout: "pipe",
      stderr: "pipe",
    });
    if ((result.exitCode ?? 1) !== 0) return "skip: git is absent";
  } catch {
    return "skip: git is absent";
  }
  return undefined;
}

const gitSkip = gitMissingReason();

describe("tracked text hygiene", () => {
  beforeEach(() => {
    delete process.env["SLACK_WEBHOOK_URL"];
  });

  it.skipIf(gitSkip !== undefined)(gitSkip ?? "holds no em dash or en dash", () => {
    // source: code review of the 2026-10-12 export
    // source: house rule, no tracked text file contains U+2014 or U+2013
    const result = Bun.spawnSync(["git", "ls-files", "-z"], {
      cwd: REPO_ROOT,
      env: gitEnv(),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    const paths = result.stdout.toString("utf8").split("\0").filter((path) => path.length > 0);
    expect(paths.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const path of paths) {
      if (isLockFile(path)) continue;
      const full = join(REPO_ROOT, path);
      try {
        if (!lstatSync(full).isFile()) continue;
      } catch {
        continue;
      }
      const bytes = readFileSync(full);
      if (bytes.includes(0)) continue;
      const text = bytes.toString("utf8");
      if (text.includes(EM_DASH) || text.includes(EN_DASH)) {
        offenders.push(path);
      }
    }

    expect(offenders, `em dash or en dash in: ${offenders.join(", ")}`).toEqual([]);
  });
});
