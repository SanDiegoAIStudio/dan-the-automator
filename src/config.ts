import { join } from "node:path";

export function env(key: string): string | undefined {
  return process.env[key];
}

export function dataDir(): string {
  return env("DAN_DATA_DIR") ?? join(process.cwd(), "data");
}

export function controlToken(): string | undefined {
  return env("DAN_CONTROL_TOKEN");
}

export function serverPort(): number {
  const raw = env("PORT");
  if (!raw) return 3456;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3456;
}

export const VERSION = "0.2.0";
export const SERVICE_NAME = "dan-the-automator";
