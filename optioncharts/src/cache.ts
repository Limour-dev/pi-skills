/**
 * Best-effort on-disk cache for `/async/*` fragments.
 *
 * optioncharts.io serves a weak ETag but never returns 304, and there is no CDN
 * cache to lean on, so a short local cache is the only way to keep a multi-expiry
 * scan from re-fetching the same fragment. The cache never makes a request fail:
 * every filesystem error is swallowed. `--no-cache` bypasses the lookup.
 */

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

export const CACHE_TTL_SECONDS = 60;

export interface CacheEntry {
  url: string;
  cached_at: number;
  status: number;
  body: string;
}

export function cacheDir(): string {
  if (process.env.OPTIONCHARTS_CACHE_DIR) return process.env.OPTIONCHARTS_CACHE_DIR;
  const base = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(base, "optioncharts");
}

function cachePath(url: string): string {
  const hash = createHash("sha1").update(url).digest("hex").slice(0, 20);
  return join(cacheDir(), `${hash}.json`);
}

export function cacheGet(url: string, ttlSeconds = CACHE_TTL_SECONDS): CacheEntry | null {
  try {
    const entry = JSON.parse(readFileSync(cachePath(url), "utf8")) as CacheEntry;
    if (entry.url !== url) return null;
    if (Date.now() - entry.cached_at > ttlSeconds * 1000) return null;
    return entry;
  } catch {
    return null;
  }
}

export function cachePut(entry: Omit<CacheEntry, "cached_at">): void {
  try {
    mkdirSync(cacheDir(), { recursive: true });
    writeFileSync(cachePath(entry.url), JSON.stringify({ ...entry, cached_at: Date.now() }));
  } catch {
    /* best effort */
  }
}
