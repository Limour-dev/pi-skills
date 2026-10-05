/**
 * Zero-dependency HTTP client for the Massive REST API (polygon.io-compatible).
 *
 * Responsibilities:
 *   - API key injection (never logged, never echoed back to stdout)
 *   - typed, actionable errors for 401 / 403 NOT_AUTHORIZED / 404 / 429 / 5xx
 *   - cursor pagination (`next_url`) with page + item caps
 *   - 429/5xx retry with backoff that honours `Retry-After`
 *
 * Docs: https://massive.com/docs/rest/quickstart
 */

export const DEFAULT_BASE_URL = "https://api.massive.com";
export const SIGNUP_URL = "https://massive.com/dashboard/signup";
export const KEYS_URL = "https://massive.com/dashboard/keys";
export const PRICING_URL = "https://massive.com/pricing";

/** Redact credentials so they can never leak into logs or JSON output. */
export function redactUrl(url: string): string {
  return url.replace(/([?&](?:apiKey|api_key)=)[^&]*/gi, "$1***");
}

export interface MassiveErrorInit {
  status?: number;
  code?: string;
  endpoint?: string;
  hint?: string;
  body?: string;
}

/** Base class for every failure raised by this library. */
export class MassiveError extends Error {
  readonly status: number | undefined;
  readonly code: string | undefined;
  readonly endpoint: string | undefined;
  readonly hint: string | undefined;
  readonly body: string | undefined;

  constructor(message: string, init: MassiveErrorInit = {}) {
    super(message);
    this.name = "MassiveError";
    this.status = init.status;
    this.code = init.code;
    this.endpoint = init.endpoint ? redactUrl(init.endpoint) : undefined;
    this.hint = init.hint;
    this.body = init.body;
  }

  /** Fully-formed message including the optional remediation hint. */
  get detail(): string {
    const parts = [this.message];
    if (this.endpoint) parts.push(`  endpoint: ${this.endpoint}`);
    if (this.hint) parts.push(`  hint: ${this.hint}`);
    return parts.join("\n");
  }
}

/** Missing, malformed or revoked API key (HTTP 401). */
export class AuthError extends MassiveError {
  constructor(message: string, init: MassiveErrorInit = {}) {
    super(message, init);
    this.name = "AuthError";
  }
}

/** Key is valid but the current plan does not include this endpoint (HTTP 403). */
export class EntitlementError extends MassiveError {
  constructor(message: string, init: MassiveErrorInit = {}) {
    super(message, init);
    this.name = "EntitlementError";
  }
}

export class NotFoundError extends MassiveError {
  constructor(message: string, init: MassiveErrorInit = {}) {
    super(message, init);
    this.name = "NotFoundError";
  }
}

export class RateLimitError extends MassiveError {
  constructor(message: string, init: MassiveErrorInit = {}) {
    super(message, init);
    this.name = "RateLimitError";
  }
}

export interface ClientOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  /** Retries for 429 / 5xx / network errors. Default 3. */
  maxRetries?: number;
  /** Upper bound for a single Retry-After wait. Default 60000 ms. */
  maxWaitMs?: number;
  /** Called before each retry sleep (used for progress notes on stderr). */
  onRetry?: (info: { attempt: number; status: number; waitMs: number; url: string }) => void;
}

export interface Page<T> {
  results: T[];
  status?: string;
  count?: number;
  next_url?: string;
}

export interface CollectResult<T> {
  results: T[];
  pages: number;
  truncated: boolean;
}

type QueryValue = string | number | boolean | undefined | null;

export function buildQuery(params: Record<string, QueryValue>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class MassiveClient {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly maxWaitMs: number;

  /** Number of HTTP requests actually issued (used for rate-limit reporting). */
  requests = 0;

  #onRetry: ClientOptions["onRetry"];

  constructor(opts: ClientOptions) {
    if (!opts.apiKey) {
      throw new AuthError("No Massive API key configured.", {
        hint: `set MASSIVE_API_KEY (or pass --api-key). Get a key at ${SIGNUP_URL} / ${KEYS_URL}`,
      });
    }
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.maxWaitMs = opts.maxWaitMs ?? 60_000;
    this.#onRetry = opts.onRetry;
  }

  /** Build an absolute URL for a path + query, injecting the API key. */
  url(pathOrUrl: string, params: Record<string, QueryValue> = {}): string {
    if (/^https?:\/\//i.test(pathOrUrl)) {
      const u = new URL(pathOrUrl);
      if (!u.searchParams.has("apiKey")) u.searchParams.set("apiKey", this.apiKey);
      return u.toString();
    }
    const base = this.baseUrl + (pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`);
    return base + buildQuery({ ...params, apiKey: this.apiKey });
  }

  /** True when the response is an entitlement rejection for a given endpoint. */
  async canAccess(pathOrUrl: string, params: Record<string, QueryValue> = {}): Promise<boolean> {
    try {
      await this.rawGet<unknown>(pathOrUrl, { ...params, limit: params.limit ?? 1 });
      return true;
    } catch (err) {
      if (err instanceof AuthError || err instanceof EntitlementError || err instanceof NotFoundError) {
        return false;
      }
      throw err;
    }
  }

  /** GET a single page. */
  async get<T>(pathOrUrl: string, params: Record<string, QueryValue> = {}): Promise<Page<T>> {
    return this.rawGet<Page<T>>(pathOrUrl, params);
  }

  /**
   * Follow `next_url` cursors until exhausted or a cap is reached.
   * `maxPages` defaults to 20 and `maxItems` to 5000 to keep plans with tight
   * rate limits usable; both are surfaced via `truncated`.
   */
  async collect<T>(
    pathOrUrl: string,
    params: Record<string, QueryValue> = {},
    caps: { maxPages?: number; maxItems?: number } = {},
  ): Promise<CollectResult<T>> {
    const maxPages = caps.maxPages ?? 20;
    const maxItems = caps.maxItems ?? 5000;
    const results: T[] = [];
    let next: string | undefined = this.url(pathOrUrl, params);
    let pages = 0;
    let truncated = false;

    while (next) {
      if (pages >= maxPages) {
        truncated = true;
        break;
      }
      const page: Page<T> = await this.rawGet<Page<T>>(next);
      pages++;
      const batch = Array.isArray(page.results) ? page.results : [];
      results.push(...batch);
      if (results.length >= maxItems) {
        if (results.length > maxItems) results.length = maxItems;
        truncated = Boolean(page.next_url) || results.length >= maxItems;
        break;
      }
      next = page.next_url;
    }
    return { results, pages, truncated };
  }

  async rawGet<T>(pathOrUrl: string, params: Record<string, QueryValue> = {}): Promise<T> {
    const url = this.url(pathOrUrl, params);
    let attempt = 0;

    for (;;) {
      attempt++;
      this.requests++;
      let res: Response;
      try {
        res = await fetch(url, {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            Accept: "application/json",
            "User-Agent": "massive-options-skill/1.0",
          },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt <= this.maxRetries) {
          const waitMs = Math.min(1000 * 2 ** (attempt - 1), this.maxWaitMs);
          this.#retry({ attempt, status: 0, waitMs, url }, `network error: ${msg}`);
          await sleep(waitMs);
          continue;
        }
        throw new MassiveError(`Request failed after ${attempt} attempt(s): ${msg}`, {
          endpoint: url,
          hint: "check network connectivity or raise --timeout",
        });
      }

      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const capped = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** (attempt - 1);
        const waitMs = Math.min(capped, this.maxWaitMs);
        const body = await safeText(res);
        if (attempt <= this.maxRetries && !(capped > this.maxWaitMs)) {
          this.#retry({ attempt, status: res.status, waitMs, url }, describeBody(body));
          await sleep(waitMs);
          continue;
        }
        if (res.status === 429) {
          throw new RateLimitError(
            `Rate limited by Massive (HTTP 429)${attempt > 1 ? ` after ${attempt} attempts` : ""}.`,
            {
              status: 429,
              endpoint: url,
              body,
              hint:
                "free plans allow ~5 requests/minute; narrow the query (fewer expiries, --limit) " +
                "or raise --max-retries / --max-wait",
            },
          );
        }
        throw new MassiveError(`Massive returned HTTP ${res.status}.`, {
          status: res.status,
          endpoint: url,
          body,
          hint: "transient server error; retry the command",
        });
      }

      if (!res.ok) throw await this.#errorFor(res, url);

      try {
        return (await res.json()) as T;
      } catch {
        throw new MassiveError("Massive returned a non-JSON response.", {
          status: res.status,
          endpoint: url,
        });
      }
    }
  }

  #retry(info: { attempt: number; status: number; waitMs: number; url: string }, reason: string): void {
    this.#onRetry?.({ ...info, url: redactUrl(info.url) });
    void reason;
  }

  async #errorFor(res: Response, url: string): Promise<MassiveError> {
    const raw = await safeText(res);
    let code: string | undefined;
    let message: string | undefined;
    try {
      const parsed = JSON.parse(raw) as { status?: string; message?: string; error?: string };
      code = parsed.status;
      message = parsed.message ?? parsed.error;
    } catch {
      /* non-JSON error body */
    }
    const note = message ? `: ${message}` : "";
    const init: MassiveErrorInit = { status: res.status, code, endpoint: url, body: raw };

    if (res.status === 401) {
      return new AuthError(`Massive rejected the API key (HTTP 401)${note}`, {
        ...init,
        hint: `set a valid MASSIVE_API_KEY — create one at ${KEYS_URL}`,
      });
    }
    if (res.status === 403) {
      return new EntitlementError(`Not entitled to this data (HTTP 403)${note}`, {
        ...init,
        hint: `your Massive plan does not include this endpoint — see ${PRICING_URL}`,
      });
    }
    if (res.status === 404) {
      return new NotFoundError(`Not found (HTTP 404)${note}`, init);
    }
    return new MassiveError(`Massive returned HTTP ${res.status}${note}`, init);
  }
}

function describeBody(body: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: string; error?: string };
    return parsed.message ?? parsed.error ?? body;
  } catch {
    return body;
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 800);
  } catch {
    return "";
  }
}
