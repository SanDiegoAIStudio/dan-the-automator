import { describe, it, expect } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

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
  { name: "Tailscale CGNAT (100.64.0.0/10)", pattern: /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/ },
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

/**
 * SHA-256 digests of lowercase word tokens that must never appear on the public
 * map. Only digests live here: the words themselves would make this public file
 * the leak, so none appear in code, comments or messages.
 *
 * source: operator ruling that names on the private list stay off the public map.
 */
const BLOCKED_TOKEN_DIGESTS: ReadonlySet<string> = new Set([
  "0a1585bc6b3f2fcaa0380ea73c3b07379cd938f75270f178094586fda35d8e62",
  "110cda456202f5ac80f2202c9db9a6d756b403d367408cbab3642fd13b165262",
  "2853339003f6476890cd7fff02afef1620b0848190852b28efb605626b09da20",
  "42817f456a964a0de65603ccc2a037c63de2f3e37dbda9fee0322e566ee695fd",
  "5ca1634fced2e9ed38de6b8f64273aedba1e8e8be204d069770c8ba1d08ede1b",
  "67f70786288b7eea9b3cf5a29e8aabd9aa623388d5fc5b5805bec8f40ee2c220",
  "77e6f78af45f649c5f3b8ebe484a91a144eb203a34a89c8dc5b1c4ca87bc6f71",
  "7e92c11499fd4106a899eeb457db8277bd6f09dd29e683f33ae704e12fa29cae",
  "b11833a4396b84cb8262131881463ac91b52adbe0364da7678beedbf702a6408",
  "b769a6983b42d565e79bb4f3f534623453f301d39784e57804a649a67ea05327",
  "bb15d9783bc51b1ff99ff1f3b225af96821cdb89a6c4b7bed1dda78f60cdeb78",
  "cdb983afc7d0d9a31218ab86da13efbe124f34092ce242af1f99cc8f771404e0",
  "d58fc8daf00e9bc3e284c85326a8486df284212d7cc69cf562e7254b6d34a931",
]);

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Lowercase word tokens of one line: alphanumeric runs, plus dotted or hyphenated
 * joins of those runs, so a whole host name is a token as well as its parts.
 */
function wordTokens(line: string): string[] {
  const lower = line.toLowerCase();
  const runs = lower.match(/[a-z0-9]+/g) ?? [];
  const joined = lower.match(/[a-z0-9]+(?:[.-][a-z0-9]+)+/g) ?? [];
  return [...runs, ...joined];
}

/** Where a blocked token sits, as `label:line digest-prefix`. Never the token itself. */
function blockedTokenHits(label: string, text: string): string[] {
  const hits: string[] = [];
  text.split("\n").forEach((line, index) => {
    for (const token of wordTokens(line)) {
      const digest = sha256Hex(token);
      if (BLOCKED_TOKEN_DIGESTS.has(digest)) {
        hits.push(`${label}:${index + 1} digest ${digest.slice(0, 12)}`);
      }
    }
  });
  return hits;
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
      "Tailscale CGNAT (100.64.0.0/10)": "peer 100.64.0.1",
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

  it("does not leak operator-local deny needles when a local list is present", () => {
    const needles = loadLocalNeedles();
    if (needles.length === 0) {
      return;
    }
    for (const needle of needles) {
      expect(html.includes(needle), `public/index.html leaked local needle`).toBe(false);
      expect(status.includes(needle), `public/status.json leaked local needle`).toBe(false);
    }
  });

  it("keeps names on the private list off the page, by SHA-256 of each word token", () => {
    expect(BLOCKED_TOKEN_DIGESTS.size, "digest list must not be emptied").toBeGreaterThanOrEqual(13);
    expect(blockedTokenHits("index.html", html), "index.html has blocked tokens").toEqual([]);
    expect(blockedTokenHits("status.json", status), "status.json has blocked tokens").toEqual([]);
  });

  it("marks statuses as illustrative", () => {
    expect(status).toContain("Illustrative snapshot");
    expect(html).toContain("not a live telemetry feed");
  });
});
