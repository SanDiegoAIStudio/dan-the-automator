import { controlToken, localShowcase } from "./config";
import { timingSafeEqualText } from "./hmac";

/**
 * Control-plane routes that read or change signals and jobs.
 * Token unset and DAN_LOCAL_SHOWCASE is not exactly "1": unconfigured (503).
 * Token unset and DAN_LOCAL_SHOWCASE=1: open, for a laptop demo.
 * Token set: Bearer required. A missing or wrong bearer is unauthorized (401).
 */
export function authorizeControl(header: string | undefined): "ok" | "unconfigured" | "unauthorized" {
  const token = controlToken();
  if (!token) {
    return localShowcase() ? "ok" : "unconfigured";
  }
  if (!header || !timingSafeEqualText(header, `Bearer ${token}`)) {
    return "unauthorized";
  }
  return "ok";
}
