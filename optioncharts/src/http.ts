/**
 * HTTP layer for the optioncharts.io `/async/*` fragments.
 *
 * The site is a Rails + htmx app: there is no JSON API, so every "endpoint" is a
 * GET that returns an HTML fragment with the chart data inlined as
 * `var <name> = <JSON>;`. This layer only handles transport concerns (URL
 * building, gzip, timeouts, bounded retries, rate-limit detection, the optional
 * 60-second local cache); parsing lives in `html.ts` and `endpoints.ts`.
 *
 * Observations from the live site (see `references/api.md`):
 *   - no auth, no cookies, no CSRF token needed; `HX-Request` is optional
 *   - a `.json` suffix does not exist (it 500s)
 *   - TTFB is ~2 s, so timeouts are generous and retries are bounded
 *   - `Accept-Encoding: gzip` shrinks a fragment from ~113 KB to ~15 KB
 */

import { readFileSync } from "node:fs";

import { cacheGet, cachePut, CACHE_TTL_SECONDS } from "./cache.ts";
import { NetworkError, RateLimitedError, UsageError } from "./errors.ts";
import type { FetchResult } from "./types.ts";

export const BASE_URL = "https://optioncharts.io";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRIES = 2;

export interface ClientOptions {
  timeoutMs?: number;
  retries?: number;
  noCache?: boolean;
  /** Offline mode: serve the first request from a saved fragment instead. */
  fromFile?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Query strings keep `:` and `,` readable — the server accepts both forms. */
export function buildUrl(path: string, params: Record<string, string | undefined> = {}): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    search.set(key, value);
  }
  const query = search.toString().replace(/%3A/g, ":").replace(/%2C/g, ",");
  return query ? `${BASE_URL}${path}?${query}` : `${BASE_URL}${path}`;
}

export class Client {
  readonly base: string;
  readonly timeoutMs: number;
  readonly retries: number;
  readonly noCache: boolean;
  /** Number of upstream requests actually issued (cache hits do not count). */
  requests = 0;
  private fromFileBody?: string;

  constructor(options: ClientOptions = {}) {
    this.base = BASE_URL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retries = options.retries ?? DEFAULT_RETRIES;
    this.noCache = options.noCache ?? false;
    if (options.fromFile) {
      try {
        this.fromFileBody = readFileSync(options.fromFile, "utf8");
      } catch (error) {
        throw new UsageError(`cannot read --from-file: ${(error as Error).message}`);
      }
    }
  }

  /** GET one fragment, with retries and (unless disabled) the 60s local cache. */
  async get(path: string, params: Record<string, string | undefined> = {}): Promise<FetchResult> {
    const url = buildUrl(path, params);
    const clean: Record<string, string> = {};
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") clean[key] = value;
    }

    if (this.fromFileBody !== undefined) {
      if (this.requests > 0) {
        throw new UsageError(
          "--from-file serves a single request only; this command needs more than one " +
            "(drop --from-file or narrow the command)",
        );
      }
      this.requests += 1;
      return {
        body: this.fromFileBody,
        url,
        params: clean,
        status: 200,
        latency_ms: 0,
        from_cache: false,
        fetched_at: new Date().toISOString(),
      };
    }

    if (!this.noCache) {
      const hit = cacheGet(url);
      if (hit) {
        return {
          body: hit.body,
          url,
          params: clean,
          status: hit.status,
          latency_ms: 0,
          from_cache: true,
          fetched_at: new Date(hit.cached_at).toISOString(),
        };
      }
    }

    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      if (attempt > 0) await sleep(Math.min(400 * 2 ** (attempt - 1), 2_000));
      const started = Date.now();
      try {
        const response = await fetch(url, {
          headers: {
            "User-Agent": USER_AGENT,
            Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "HX-Request": "true",
            Referer: `${this.base}/options/`,
          },
          redirect: "follow",
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        const latency = Date.now() - started;
        const body = await response.text();
        if (response.status === 429) {
          const retryAfter = Number(response.headers.get("retry-after"));
          lastError = new RateLimitedError(
            `optioncharts.io rate limited the request (HTTP 429)`,
            Number.isFinite(retryAfter) ? retryAfter : undefined,
            { url },
          );
          if (attempt < this.retries) continue;
          throw lastError;
        }
        if (response.status >= 500) {
          lastError = new NetworkError(`upstream error HTTP ${response.status} for ${url}`);
          if (attempt < this.retries) continue;
          throw lastError;
        }
        this.requests += 1;
        if (response.ok) cachePut({ url, status: response.status, body });
        return {
          body,
          url,
          params: clean,
          status: response.status,
          latency_ms: latency,
          from_cache: false,
          fetched_at: new Date().toISOString(),
        };
      } catch (error) {
        if (error instanceof RateLimitedError) throw error;
        lastError = error instanceof Error ? error : new Error(String(error));
        if ((lastError as { name?: string }).name === "TimeoutError") {
          lastError = new NetworkError(`request timed out after ${this.timeoutMs} ms: ${url}`);
        }
        if (attempt >= this.retries) {
          if (lastError instanceof NetworkError) throw lastError;
          throw new NetworkError(`request failed: ${lastError.message}`, { url });
        }
      }
    }
    throw new NetworkError(`request failed: ${lastError?.message ?? "unknown error"}`, { url });
  }
}

export { CACHE_TTL_SECONDS };
