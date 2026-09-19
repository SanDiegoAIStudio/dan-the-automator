import { describe, it, expect } from "bun:test";
import { hmacSha256Hex, timingSafeEqualText, verifyHmacSha256 } from "../src/hmac";

describe("HMAC", () => {
  it("verifies a matching signature", async () => {
    const sig = await hmacSha256Hex("secret", "body");
    expect(await verifyHmacSha256("secret", "body", sig)).toBe(true);
    expect(await verifyHmacSha256("secret", "body", "0".repeat(sig.length))).toBe(false);
  });

  it("rejects unequal lengths without throwing", () => {
    expect(timingSafeEqualText("aa", "a")).toBe(false);
    expect(timingSafeEqualText("same", "same")).toBe(true);
  });
});
