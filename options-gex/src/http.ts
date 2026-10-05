/**
 * HTTP layer: timeouts, bounded retries, rate-limit detection and the
 * optional 60-second local cache.
 */

import { cacheGet, cachePut } from "./cache.ts";
import { CliError, NetworkError, RateLimitedError } from "./errors.ts";
import type { HttpMeta } from "./types.ts";

export interface RequestOptions {
  timeoutMs?: number;
  maxRetries?: number;
  noCache?: boolean;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface HttpResult extends HttpMeta {
  url: string;
  body: string;
  headers: Record<string, string>;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_RETRIES = 2;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function headerRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

function ratelimitOf(headers: Record<string, string>): HttpMeta["ratelimit"] {
  const limit = Number(headers["ratelimit-limit"] ?? headers["x-ratelimit-limit"]);
  const remaining = Number(headers["ratelimit-remaining"] ?? headers["x-ratelimit-remaining"]);
  const reset = Number(headers["ratelimit-reset"] ?? headers["x-ratelimit-reset"]);
  if (!Number.isFinite(limit) && !Number.isFinite(remaining) && !Number.isFinite(reset)) {
    return undefined;
  }
  const out: NonNullable<HttpMeta["ratelimit"]> = {};
  if (Number.isFinite(limit)) out.limit = limit;
  if (Number.isFinite(remaining)) out.remaining = remaining;
  if (Number.isFinite(reset)) out.reset = reset;
  return out;
}

function retryDelayMs(attempt: number, headers: Record<string, string>): number {
  const retryAfter = Number(headers["retry-after"]);
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, 10_000);
  const reset = Number(headers["ratelimit-reset"] ?? headers["x-ratelimit-reset"]);
  if (Number.isFinite(reset) && reset > 0) {
    const untilReset = reset * 1000 - Date.now();
    if (untilReset > 0) return Math.min(untilReset + 200, 10_000);
  }
  return Math.min(300 * 2 ** attempt, 4_000) + Math.floor(Math.random() * 150);
}

function offline(): boolean {
  return process.env.OPTIONS_GEX_OFFLINE === "1" || process.env.OPTIONS_GEX_OFFLINE === "true";
}

/**
 * GET a URL as text. Retries network errors, 5xx and 429 with backoff; a 429
 * that survives every attempt raises `RateLimitedError` (exit 4).
 */
export async function httpGet(url: string, options: RequestOptions = {}): Promise<HttpResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = Math.max(0, options.maxRetries ?? DEFAULT_RETRIES);
  const start = Date.now();

  if (offline()) {
    throw new NetworkError("offline mode is enabled (OPTIONS_GEX_OFFLINE)", { url });
  }

  if (!options.noCache && !options.method) {
    const hit = cacheGet(url);
    if (hit) {
      return {
        url,
        body: hit.body,
        headers: {},
        status: hit.status,
        latency_ms: Date.now() - start,
        from_cache: true,
        cf_cache: hit.cf_cache,
        ratelimit: hit.ratelimit,
      };
    }
  }

  const requestUrl = options.noCache ? withCacheBuster(url) : url;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(requestUrl, {
        method: options.method ?? "GET",
        headers: {
          accept: "application/json, text/event-stream",
          "user-agent": "options-gex/1.0 (+https://github.com/Limour-dev/pi-skills)",
          ...(options.noCache ? { "cache-control": "no-cache" } : {}),
          ...options.headers,
        },
        body: options.body,
        signal: controller.signal,
      });
      const body = await response.text();
      const headers = headerRecord(response.headers);
      const meta: HttpMeta = {
        status: response.status,
        latency_ms: Date.now() - start,
        from_cache: false,
        cf_cache: headers["cf-cache-status"],
        ratelimit: ratelimitOf(headers),
      };

      if ((response.status === 429 || response.status >= 500) && attempt < maxRetries) {
        await sleep(retryDelayMs(attempt, headers));
        continue;
      }
      if (response.status === 429) {
        const reset = meta.ratelimit?.reset;
        const retryAfter = reset ? Math.max(0, reset - Math.floor(Date.now() / 1000)) : undefined;
        throw new RateLimitedError(
          `rate limited (HTTP 429) at ${url}` +
            (retryAfter !== undefined ? `; reset in ~${retryAfter}s` : "") +
            "; retry later or use --source mcp",
          retryAfter,
          { url, ratelimit: meta.ratelimit },
        );
      }
      if (response.status >= 500) {
        throw new CliError(`HTTP ${response.status} from ${url}`, {
          details: { url, status: response.status, body: body.slice(0, 300) },
        });
      }

      if (!options.method && response.ok) {
        cachePut({
          url,
          status: response.status,
          body,
          cf_cache: meta.cf_cache,
          ratelimit: meta.ratelimit,
        });
      }

      return { url, body, headers, ...meta };
    } catch (error) {
      lastError = error;
      if (error instanceof CliError) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      if (attempt < maxRetries) {
        await sleep(retryDelayMs(attempt, {}));
        continue;
      }
      throw new NetworkError(`request to ${url} failed: ${reason}`, { url });
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError : new NetworkError(`request to ${url} failed`, { url });
}

function withCacheBuster(url: string): string {
  const u = new URL(url);
  u.searchParams.set("_ts", String(Date.now()));
  return u.toString();
}
