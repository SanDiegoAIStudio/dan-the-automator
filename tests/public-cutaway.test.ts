import { describe, it, expect } from "bun:test";
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

  it("marks statuses as illustrative", () => {
    expect(status).toContain("Illustrative snapshot");
    expect(html).toContain("not a live telemetry feed");
  });
});
