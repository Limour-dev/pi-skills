/**
 * Configuration loading from environment variables.
 */
import { MinifluxError } from "./error.ts";

export interface MinifluxConfig {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
}

/**
 * Normalize the base URL: trim whitespace, strip trailing slashes and a
 * trailing "/v1" (so both `https://host/` and `https://host/v1` work).
 */
export function normalizeBaseUrl(raw: string): string {
  let url = raw.trim();
  if (!url) throw new MinifluxError("MINIFLUX_URL is empty");
  url = url.replace(/\/+$/, "");
  url = url.replace(/\/v1$/i, "");
  if (!/^https?:\/\//i.test(url)) {
    throw new MinifluxError(`MINIFLUX_URL must start with http:// or https:// (got: ${raw.trim()})`);
  }
  return url;
}

/** Read MINIFLUX_URL and MINIFLUX_API_KEY (or MINIFLUX_API_TOKEN) from the environment. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): MinifluxConfig {
  const baseUrl = env.MINIFLUX_URL;
  const apiKey = env.MINIFLUX_API_KEY ?? env.MINIFLUX_API_TOKEN;
  if (!baseUrl) throw new MinifluxError("MINIFLUX_URL environment variable is required");
  if (!apiKey) {
    throw new MinifluxError("MINIFLUX_API_KEY (or MINIFLUX_API_TOKEN) environment variable is required");
  }
  return { baseUrl: normalizeBaseUrl(baseUrl), apiKey };
}
