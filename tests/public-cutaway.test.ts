import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FORBIDDEN = [
  "/Users/lucascooper",
  "lucascooper-bey",
  "~/Developer",
  "~/.claude",
  "100.93.211.33",
  "100.111.188.5",
  "@pluributtBot",
  "ep-blue-tree",
  "orange-waterfall",
  "makerschool",
  "Jesse 50/50",
  "$1-1.6M",
  "$420K",
  "$640K",
  "source-chat",
  "eecd690f",
  "v1.5a",
];

describe("Public cutaway", () => {
  const html = readFileSync(join(import.meta.dir, "..", "public", "index.html"), "utf8");
  const status = readFileSync(join(import.meta.dir, "..", "public", "status.json"), "utf8");

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

  it("does not leak private paths, IPs, handles, or dollar theater", () => {
    for (const needle of FORBIDDEN) {
      expect(html.includes(needle)).toBe(false);
    }
    for (const needle of FORBIDDEN) {
      expect(status.includes(needle)).toBe(false);
    }
  });

  it("marks statuses as illustrative", () => {
    expect(status).toContain("Illustrative snapshot");
    expect(html).toContain("not a live telemetry feed");
  });
});
