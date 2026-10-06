import { describe, it, expect } from "bun:test";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const REPO_ROOT = join(import.meta.dir, "..");
const PUBLIC_DIR = join(import.meta.dir, "..", "public");
/** Gitignored. Schema: `{ "needles": string[] }`. Missing file skips extra needles. */
const LOCAL_DENY_PATH = join(import.meta.dir, "private-deny.local.json");

const LocalDenySchema = z.object({
  needles: z.array(z.string().min(1)),
});

/**
 * Class-of-leak guards only. Concrete hosts, handles, client names, and
 * exact IPs belong in the gitignored local deny file — never here.
 */
const LEAK_CLASSES: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "macOS home path", pattern: /\/Users\// },
  { name: "Linux home path", pattern: /\/home\/[A-Za-z0-9._-]+\// },
  { name: "Windows home path", pattern: /\\Users\\/ },
  { name: "home-dir shorthand", pattern: /~\/(?:\.|[A-Za-z])/ },
  { name: "CGNAT range (100.64.0.0/10)", pattern: /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/ },
  { name: "bot handle", pattern: /@[A-Za-z0-9_]{2,}[Bb]ot\b/ },
  { name: "Neon-style endpoint id", pattern: /\bep-[a-z]+-[a-z]+(?:-[a-z0-9]+)?\b/ },
  { name: "dollar-range theater", pattern: /\$\d+(?:\.\d+)?\s*[-–]\s*\$?\d+(?:\.\d+)?[KMB]\b/ },
  { name: "million-dollar theater", pattern: /\$\d+(?:\.\d+)?M\b/ },
  { name: "large kilo-dollar theater", pattern: /\$\d{3,}(?:\.\d+)?K\b/ },
  { name: "GitHub PAT shape", pattern: /\bghp_[A-Za-z0-9]{20,}\b/ },
  { name: "AWS access key shape", pattern: /\bAKIA[A-Z0-9]{16}\b/ },
  { name: "OpenAI-style secret key", pattern: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { name: "Slack token shape", pattern: /\bxox[baprs]-/ },
];

function loadLocalNeedles(): string[] {
  if (!existsSync(LOCAL_DENY_PATH)) {
    return [];
  }
  const raw: unknown = JSON.parse(readFileSync(LOCAL_DENY_PATH, "utf8"));
  return LocalDenySchema.parse(raw).needles;
}

function assertNoClassLeaks(haystack: string, label: string): void {
  for (const { name, pattern } of LEAK_CLASSES) {
    const match = haystack.match(pattern);
    expect(match, `${label} leaked ${name}${match?.[0] ? `: ${match[0]}` : ""}`).toBeNull();
  }
}

type TrackedText = { path: string; text: string };
type NeedleHit = { path: string; line: number; needleIndex: number };

function listTrackedTextFiles(repoRoot: string): string[] {
  const result = Bun.spawnSync(["git", "ls-files", "-z"], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error("could not list tracked files: git exited non-zero");
  }
  const paths = result.stdout.toString("utf8").split("\0").filter((path) => path.length > 0);
  if (paths.length === 0) {
    throw new Error("could not list tracked files: git returned no paths");
  }
  return paths.filter((path) => {
    try {
      return lstatSync(join(repoRoot, path)).isFile();
    } catch {
      return false;
    }
  }).filter((path) => !readFileSync(join(repoRoot, path)).subarray(0, 8000).includes(0));
}

function isGitWorkTree(repoRoot: string): boolean {
  try {
    const result = Bun.spawnSync(["git", "rev-parse", "--is-inside-work-tree"], {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    return result.exitCode === 0 && result.stdout.toString("utf8").trim() === "true";
  } catch {
    return false;
  }
}

function findNeedleHits(files: ReadonlyArray<TrackedText>, needles: ReadonlyArray<string>): NeedleHit[] {
  const hits: NeedleHit[] = [];
  for (const file of files) {
    file.text.split("\n").forEach((line, lineIndex) => {
      needles.forEach((needle, needleIndex) => {
        if (line.includes(needle)) {
          hits.push({ path: file.path, line: lineIndex + 1, needleIndex });
        }
      });
    });
  }
  return hits;
}

function formatNeedleHits(hits: ReadonlyArray<NeedleHit>): string {
  return hits.map(({ path, line, needleIndex }) => `${path}:${line} (needle #${needleIndex})`).join("\n");
}

describe("Public cutaway", () => {
  const html = readFileSync(join(PUBLIC_DIR, "index.html"), "utf8");
  const status = readFileSync(join(PUBLIC_DIR, "status.json"), "utf8");

  it("keeps the cockpit: tour, index, pan/zoom, flywheel, disclaimer", () => {
    expect(html).toContain("btnTour");
    expect(html).toContain("btnIndex");
    expect(html).toContain("pFly");
    expect(html).toContain("search the machine");
    expect(html).toContain("Illustrative map");
    expect(html).toContain("sandiegoaistudio.com");
    expect(html).toContain("San Diego AI Studio");
    expect(html).toContain("SDAIS · the heart");
  });

  it("does not leak private path, CGNAT, handle, or secret-shape classes", () => {
    assertNoClassLeaks(html, "public/index.html");
    assertNoClassLeaks(status, "public/status.json");
  });

  it("fail-closes on synthetic class-of-leak stand-ins", () => {
    const standIns: Record<string, string> = {
      "macOS home path": "see /Users/operator/src",
      "Linux home path": "see /home/operator/src/",
      "Windows home path": "see C:\\Users\\operator",
      "home-dir shorthand": "notes in ~/.config/dan",
      "CGNAT range (100.64.0.0/10)": "peer 100.64.0.1",
      "bot handle": "ping @exampleBot",
      "Neon-style endpoint id": "host ep-sample-name",
      "dollar-range theater": "claim $2-4M",
      "million-dollar theater": "claim $2M",
      "large kilo-dollar theater": "claim $999K",
      "GitHub PAT shape": "ghp_" + "a".repeat(20),
      "AWS access key shape": "AKIA" + "A".repeat(16),
      "OpenAI-style secret key": "sk-" + "a".repeat(20),
      "Slack token shape": "xoxb-example",
    };
    for (const { name, pattern } of LEAK_CLASSES) {
      const sample = standIns[name];
      expect(sample, `missing stand-in for ${name}`).toBeString();
      expect(pattern.test(sample ?? ""), `${name} must match its stand-in`).toBe(true);
    }
  });

  it("does not treat illustrative $10K/$30K gate marks as dollar theater", () => {
    assertNoClassLeaks("$10K MRR", "illustrative $10K");
    assertNoClassLeaks("$30K MRR", "illustrative $30K");
    assertNoClassLeaks("$10K → $30K MRR", "illustrative gate range");
  });

  it("does not leak operator-local deny needles in any tracked text file when a local list is present", () => {
    // source: 2026-10-06, a word from the local deny file sat on two lines of this test file while the test read only public/index.html and public/status.json
    const needles = loadLocalNeedles();
    if (needles.length === 0) {
      return;
    }
    const files: TrackedText[] = listTrackedTextFiles(REPO_ROOT).map((path) => ({
      path,
      text: readFileSync(join(REPO_ROOT, path), "utf8"),
    }));
    const hits = findNeedleHits(files, needles);
    expect(hits.length, `tracked files leaked local needles:\n${formatNeedleHits(hits)}`).toBe(0);
  });

  it("finds a needle in any file, by path, line and index, without echoing it", () => {
    // source: rule, the scan reports where a needle is and never what it is
    const needle = "zz-synthetic-needle";
    const files: TrackedText[] = [
      { path: "src/example.ts", text: "export const example = true;" },
      { path: "tests/example.test.ts", text: `first line\n${needle}\nlast line` },
      { path: "docs/example.md", text: needle.toUpperCase() },
    ];
    const hits = findNeedleHits(files, [needle]);
    expect(hits).toEqual([{ path: "tests/example.test.ts", line: 2, needleIndex: 0 }]);
    expect(findNeedleHits(files.slice(0, 1), [needle])).toEqual([]);
    expect(findNeedleHits(files.slice(1, 2), [needle.toUpperCase()])).toEqual([]);

    const secondNeedle = "zz-synthetic-other";
    const sharedLineHits = findNeedleHits(
      [{ path: "src/example.ts", text: `${secondNeedle} ${needle} ${needle}` }],
      [needle, secondNeedle],
    );
    expect(sharedLineHits).toEqual([
      { path: "src/example.ts", line: 1, needleIndex: 0 },
      { path: "src/example.ts", line: 1, needleIndex: 1 },
    ]);

    const formatted = formatNeedleHits([...hits, ...sharedLineHits]);
    expect(formatted).toBe("tests/example.test.ts:2 (needle #0)\nsrc/example.ts:1 (needle #0)\nsrc/example.ts:1 (needle #1)");
    expect(formatted.includes(needle)).toBe(false);
    expect(formatted.includes(secondNeedle)).toBe(false);
  });

  it("lists tracked text files, tests included", () => {
    // source: rule, the deny scan covers every tracked text file and never the ignored deny file itself
    if (!isGitWorkTree(REPO_ROOT)) { return; }
    const paths = listTrackedTextFiles(REPO_ROOT);
    expect(paths).toContain("tests/public-cutaway.test.ts");
    expect(paths).toContain("README.md");
    expect(paths).toContain("public/index.html");
    expect(paths.some((path) => path.startsWith("node_modules/"))).toBe(false);
    expect(paths.some((path) => path.startsWith(".git/"))).toBe(false);
    expect(paths).not.toContain("tests/private-deny.local.json");
  });

  it("skips tracked paths that are not regular files", () => {
    // source: review of the widened scan, a deleted but unstaged tracked file made readFileSync throw
    const dir = mkdtempSync(join(tmpdir(), "dan-scan-"));
    const emptyDir = mkdtempSync(join(tmpdir(), "dan-scan-"));
    try {
      const runGit = (...args: string[]): void => {
        const result = Bun.spawnSync([
          "git",
          "-c", "core.hooksPath=/dev/null",
          "-c", "commit.gpgsign=false",
          "-c", "user.name=Test",
          "-c", "user.email=test@example.invalid",
          ...args,
        ], {
          cwd: dir,
          stdout: "pipe",
          stderr: "pipe",
        });
        expect(result.exitCode, `git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`).toBe(0);
      };
      runGit("init");
      writeFileSync(join(dir, "a.txt"), "a\n");
      writeFileSync(join(dir, "b.txt"), "b\n");
      runGit("add", "a.txt", "b.txt");
      runGit("commit", "-m", "Track scan fixtures");
      rmSync(join(dir, "b.txt"));

      expect(listTrackedTextFiles(dir)).toEqual(["a.txt"]);
      expect(isGitWorkTree(dir)).toBe(true);
      expect(isGitWorkTree(emptyDir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it("marks statuses as illustrative", () => {
    expect(status).toContain("Illustrative snapshot");
    expect(html).toContain("not a live telemetry feed");
  });
});
