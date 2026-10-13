import { isAbsolute, join, resolve } from "node:path";

export function env(key: string): string | undefined {
  return process.env[key];
}

export const BIND_REFUSAL =
  "Refusing to start: DAN_HOST is not a loopback address and DAN_CONTROL_TOKEN is unset";

export const UNSIGNED_BIND_REFUSAL =
  "Refusing to start: DAN_ALLOW_UNSIGNED_WEBHOOKS=1 and DAN_HOST is not a loopback address";

export const SHOWCASE_CONTENT_TYPE = "Content-Type must be application/json";
export const SHOWCASE_ORIGIN = "Origin is not allowed";
export const SHOWCASE_HOST = "Host is not allowed";

export function dataDir(): string {
  const raw = env("DAN_DATA_DIR");
  if (raw !== undefined && raw.trim() === "") {
    throw new Error("DAN_DATA_DIR is empty");
  }
  if (raw === undefined) return join(process.cwd(), "data");
  return isAbsolute(raw) ? raw : resolve(raw);
}

export function dataDirLogLine(): string {
  return `[Dan] Data dir: ${dataDir()}`;
}

function configuredSecret(key: string): string | undefined {
  const raw = env(key);
  if (raw === undefined || raw.trim() === "") return undefined;
  return raw;
}

export function controlToken(): string | undefined {
  return configuredSecret("DAN_CONTROL_TOKEN");
}

export function webhookSecret(): string | undefined {
  return configuredSecret("SENTRY_WEBHOOK_SECRET");
}

/** Exactly "1" opens control routes when no control token is set. Laptop demo only. */
export function localShowcase(): boolean {
  return env("DAN_LOCAL_SHOWCASE") === "1";
}

const LOOPBACK_NAMES = new Set(["localhost", "::1", "[::1]"]);

export function isLoopbackHost(host: string): boolean {
  const value = host.trim().toLowerCase();
  if (LOOPBACK_NAMES.has(value)) return true;
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== "127") return false;
  for (const part of parts) {
    if (!/^[0-9]{1,3}$/.test(part)) return false;
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return false;
  }
  return true;
}

/** Default 127.0.0.1. DAN_HOST overrides it, including a blank value. */
export function serverHost(): string {
  const raw = env("DAN_HOST");
  if (raw === undefined) return "127.0.0.1";
  return raw.trim();
}

/**
 * Null when the process may listen. A string is a one-line refusal:
 * empty DAN_DATA_DIR, a non-loopback DAN_HOST with no control token,
 * or DAN_ALLOW_UNSIGNED_WEBHOOKS=1 on a non-loopback bind.
 * DAN_LOCAL_SHOWCASE does not override the bind refusal.
 */
export function startupRefusal(): string | null {
  try {
    dataDir();
  } catch (err: unknown) {
    return err instanceof Error ? err.message : String(err);
  }
  if (!isLoopbackHost(serverHost()) && !controlToken()) return BIND_REFUSAL;
  if (!isLoopbackHost(serverHost()) && env("DAN_ALLOW_UNSIGNED_WEBHOOKS") === "1") {
    return UNSIGNED_BIND_REFUSAL;
  }
  return null;
}

/** Showcase mutating routes require JSON and a loopback Origin when one is sent. */
export function showcaseMutationBlock(
  contentType: string | undefined,
  origin: string | undefined,
): { error: string; status: 400 } | null {
  if (!localShowcase()) return null;
  const media = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (media !== "application/json") {
    return { error: SHOWCASE_CONTENT_TYPE, status: 400 };
  }
  if (origin !== undefined && !isShowcaseOrigin(origin)) {
    return { error: SHOWCASE_ORIGIN, status: 400 };
  }
  return null;
}

function isShowcaseOrigin(origin: string): boolean {
  const port = serverPort();
  return origin === `http://localhost:${port}` || origin === `http://127.0.0.1:${port}`;
}

/** Showcase control routes require Host `localhost:<port>` or `127.0.0.1:<port>`. */
export function showcaseHostBlock(host: string | undefined): { error: string; status: 400 } | null {
  if (!localShowcase()) return null;
  const port = String(serverPort());
  const value = host?.trim().toLowerCase() ?? "";
  if (value === `localhost:${port}` || value === `127.0.0.1:${port}`) return null;
  return { error: SHOWCASE_HOST, status: 400 };
}

export function serverPort(): number {
  const raw = env("PORT");
  if (!raw) return 3456;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3456;
}

export const VERSION = "0.2.0";
export const SERVICE_NAME = "dan-the-automator";
