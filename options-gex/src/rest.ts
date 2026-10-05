/**
 * REST channel: `GET https://sellthenews.org/api/options/chain`.
 *
 * Primary channel — native JSON, no handshake, complete field set. Known
 * quirks this module compensates for:
 *   - the expiry parameter is `exp`, not `expiration`;
 *   - `maxStrikes` is ignored (the payload always carries every strike);
 *   - an unparsable or unavailable `exp` is silently replaced by the nearest
 *     expiry, so the caller must compare `selected_exp` with the request.
 */

import { CliError, DataUnavailableError, UsageError } from "./errors.ts";
import { httpGet, type RequestOptions } from "./http.ts";
import type { HttpMeta, RestChain } from "./types.ts";
import { isIsoDate } from "./num.ts";

export const DEFAULT_API_BASE = "https://sellthenews.org";

export function apiBase(): string {
  return (process.env.OPTIONS_GEX_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, "");
}

export function chainUrl(ticker: string, exp?: string, greeks?: string): string {
  const url = new URL(`${apiBase()}/api/options/chain`);
  url.searchParams.set("ticker", ticker);
  if (exp) url.searchParams.set("exp", exp);
  if (greeks) url.searchParams.set("greeks", greeks);
  return url.toString();
}

export interface RestResult {
  chain: RestChain;
  url: string;
  meta: HttpMeta;
}

export interface ChainRequest extends RequestOptions {
  ticker: string;
  exp?: string;
  greeks?: string;
}

/** Fetch and validate one chain snapshot. Never returns `ok:false`. */
export async function fetchChain(request: ChainRequest): Promise<RestResult> {
  const url = chainUrl(request.ticker, request.exp, request.greeks);
  const response = await httpGet(url, {
    timeoutMs: request.timeoutMs,
    maxRetries: request.maxRetries,
    noCache: request.noCache,
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    throw new CliError(
      `non-JSON response from ${url} (HTTP ${response.status})` +
        (response.body.trimStart().startsWith("<")
          ? " — looks like a Cloudflare challenge page; retry or use --source mcp"
          : ""),
      { details: { url, status: response.status, body: response.body.slice(0, 300) } },
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliError(`unexpected response shape from ${url}`, {
      details: { url, status: response.status },
    });
  }

  const chain = parsed as RestChain;
  if (chain.ok !== true) {
    const message = typeof chain.error === "string" && chain.error ? chain.error : "options data unavailable";
    throw new DataUnavailableError(message, { url, status: response.status, ticker: request.ticker });
  }
  if (!chain.expiration) {
    throw new CliError(`response from ${url} has ok:true but no expiration block`, {
      details: { url, ticker: request.ticker },
    });
  }

  return { chain, url, meta: response };
}

/** Client-side guard: only `--exp` values the API accepts are worth sending. */
export function assertExpiryFormat(exp: string): void {
  if (!isIsoDate(exp)) {
    throw new UsageError(`--exp must be YYYY-MM-DD (got "${exp}")`);
  }
}
