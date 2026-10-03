/** Shared HTTP layer for the three public Polymarket REST APIs. */

export const GAMMA = "https://gamma-api.polymarket.com";
export const CLOB = "https://clob.polymarket.com";
export const DATA = "https://data-api.polymarket.com";

export class ApiError extends Error {
  url: string;
  status: number;
  body: string;

  constructor(url: string, status: number, body: string) {
    super(`HTTP ${status} from ${url}${body ? ` — ${body.slice(0, 300)}` : ""}`);
    this.name = "ApiError";
    this.url = url;
    this.status = status;
    this.body = body;
  }
}

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`not found: ${what}`);
    this.name = "NotFoundError";
  }
}

const DEFAULT_TIMEOUT_MS = 20_000;

async function request(url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) {
      // 404 is a normal "this slug does not exist" signal for the resolver.
      // Report only the path so messages stay readable.
      throw new NotFoundError(new URL(url).pathname + new URL(url).search);
      throw new ApiError(url, res.status, text);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new ApiError(url, res.status, `response was not JSON: ${text.slice(0, 200)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

export function getJson<T = unknown>(url: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  return request(url, { method: "GET", headers: { accept: "application/json" } }, timeoutMs) as Promise<T>;
}

export function postJson<T = unknown>(
  url: string,
  body: unknown,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  return request(
    url,
    {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    timeoutMs,
  ) as Promise<T>;
}

/** Build a query string, dropping undefined/null/empty values. */
export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}
