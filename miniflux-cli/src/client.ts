/**
 * Miniflux API client.
 *
 * Reads MINIFLUX_URL and MINIFLUX_API_KEY from the environment.
 * MINIFLUX_URL should be the API base URL, e.g. https://rcdn.limour.top/
 */

export interface MinifluxConfig {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
}

export class MinifluxError extends Error {
  status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "MinifluxError";
    this.status = status;
  }
}

/** Normalize the base URL: strip trailing slashes and any trailing "/v1". */
export function normalizeBaseUrl(raw: string): string {
  let url = raw.trim();
  if (!url) throw new MinifluxError("MINIFLUX_URL is not set");
  // strip trailing slashes
  url = url.replace(/\/+$/, "");
  // strip a trailing "/v1" (case-insensitive) so we can uniformly append "/v1/..."
  url = url.replace(/\/v1$/i, "");
  return url;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): MinifluxConfig {
  const baseUrl = env.MINIFLUX_URL;
  const apiKey = env.MINIFLUX_API_KEY ?? env.MINIFLUX_API_TOKEN;
  if (!baseUrl) throw new MinifluxError("MINIFLUX_URL environment variable is required");
  if (!apiKey)
    throw new MinifluxError("MINIFLUX_API_KEY (or MINIFLUX_API_TOKEN) environment variable is required");
  return { baseUrl: normalizeBaseUrl(baseUrl), apiKey };
}

export class MinifluxClient {
  private baseUrl: string;
  private apiKey: string;
  private timeoutMs: number;

  constructor(config: MinifluxConfig) {
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs ?? 30000;
  }

  private endpoint(path: string): string {
    return `${this.baseUrl}/v1/${path.replace(/^\/+/, "")}`;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
    rawBody?: string,
  ): Promise<T> {
    return this.doFetch<T>(method, path, body, headers, rawBody, true);
  }

  /** For endpoints that return raw text (OPML), not JSON. */
  private async requestRawText(method: string, path: string, rawBody?: string): Promise<string> {
    return this.doFetch<string>(method, path, undefined, { "Content-Type": "text/xml" }, rawBody, false);
  }

  private async doFetch<T>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
    rawBody?: string,
    parseJson: boolean = true,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.endpoint(path), {
        method,
        headers: {
          "X-Auth-Token": this.apiKey,
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...headers,
        },
        body: rawBody ?? (body !== undefined ? JSON.stringify(body) : undefined),
        signal: controller.signal,
      });

      if (!res.ok) {
        let detail = "";
        try {
          const j = (await res.json()) as { error_message?: string; message?: string };
          detail = j.error_message ?? j.message ?? "";
        } catch {
          /* ignore body parse errors */
        }
        throw new MinifluxError(
          `Miniflux API ${res.status} ${res.statusText} on ${method} ${path}${detail ? `: ${detail}` : ""}`,
          res.status,
        );
      }

      if (res.status === 204 || res.headers.get("content-length") === "0") return undefined as T;
      const text = await res.text();
      if (!parseJson) return text as T;
      if (!text) return undefined as T;
      return JSON.parse(text) as T;
    } catch (err) {
      if (err instanceof MinifluxError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new MinifluxError(`Request timed out after ${this.timeoutMs}ms: ${method} ${path}`);
      }
      throw new MinifluxError(`Network error on ${method} ${path}: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- Read tools ----

  healthcheck(): Promise<void> {
    // Try the canonical healthcheck endpoint first, then the root of the base URL.
    // Miniflux versions differ on whether `/v1/healthcheck` exists; the instance is
    // considered reachable if the server answers at all.
    return (async () => {
      try {
        await this.request("GET", "healthcheck");
      } catch {
        const res = await fetch(`${this.baseUrl}/`);
        if (!res.ok) throw new MinifluxError(`Miniflux returned HTTP ${res.status}`);
      }
    })();
  }

  getMe(): Promise<unknown> {
    return this.request("GET", "me");
  }

  getUserById(id: number): Promise<unknown> {
    return this.request("GET", `users/${id}`);
  }

  getUserByName(username: string): Promise<unknown> {
    return this.request("GET", `users/${encodeURIComponent(username)}`);
  }

  getFeeds(): Promise<unknown> {
    return this.request("GET", "feeds");
  }

  getFeed(id: number): Promise<unknown> {
    return this.request("GET", `feeds/${id}`);
  }

  getFeedIcon(id: number): Promise<unknown> {
    return this.request("GET", `feeds/${id}/icon`);
  }

  discover(url: string): Promise<unknown> {
    return this.request("POST", "discover", { url });
  }

  getEntries(
    filters: Partial<{
      status: string;
      offset: number;
      limit: number;
      order: string;
      direction: string;
      before: number;
      after: number;
      beforeEntryId: number;
      afterEntryId: number;
      starred: boolean;
    }> = {},
  ): Promise<unknown> {
    const qs = this.entryQueryString(filters);
    return this.request("GET", `entries${qs}`);
  }

  getEntry(id: number): Promise<unknown> {
    return this.request("GET", `entries/${id}`);
  }

  getFeedEntries(
    feedId: number,
    filters: Partial<{
      status: string;
      offset: number;
      limit: number;
      order: string;
      direction: string;
      before: number;
      after: number;
      beforeEntryId: number;
      afterEntryId: number;
      starred: boolean;
    }> = {},
  ): Promise<unknown> {
    const qs = this.entryQueryString(filters);
    return this.request("GET", `feeds/${feedId}/entries${qs}`);
  }

  getCategories(): Promise<unknown> {
    return this.request("GET", "categories");
  }

  exportOpml(): Promise<string> {
    return this.requestRawText("GET", "export/opml");
  }

  // ---- Write tools ----

  importOpml(opml: string): Promise<void> {
    return this.requestRawText("POST", "import/opml", opml).then(() => undefined);
  }

  createCategory(title: string): Promise<unknown> {
    return this.request("POST", "categories", { title });
  }

  updateCategory(id: number, title: string): Promise<unknown> {
    return this.request("PUT", `categories/${id}`, { title });
  }

  deleteCategory(id: number): Promise<unknown> {
    return this.request("DELETE", `categories/${id}`);
  }

  createFeed(feedUrl: string, categoryId: number): Promise<unknown> {
    return this.request("POST", "feeds", { feed_url: feedUrl, category_id: categoryId });
  }

  updateFeed(
    id: number,
    fields: Partial<{
      title: string;
      categoryId: number;
      feedUrl: string;
      siteUrl: string;
      userAgent: string;
    }>,
  ): Promise<unknown> {
    const body: Record<string, unknown> = {};
    if (fields.title !== undefined) body.title = fields.title;
    if (fields.categoryId !== undefined) body.category_id = fields.categoryId;
    if (fields.feedUrl !== undefined) body.feed_url = fields.feedUrl;
    if (fields.siteUrl !== undefined) body.site_url = fields.siteUrl;
    if (fields.userAgent !== undefined) body.user_agent = fields.userAgent;
    return this.request("PUT", `feeds/${id}`, body);
  }

  deleteFeed(id: number): Promise<unknown> {
    return this.request("DELETE", `feeds/${id}`);
  }

  refreshFeed(id: number): Promise<void> {
    return this.request("PUT", `feeds/${id}/refresh`);
  }

  updateEntryStatus(entryIds: number[], status: string): Promise<void> {
    return this.request("PUT", "entries", { entry_ids: entryIds, status });
  }

  toggleBookmark(id: number): Promise<void> {
    return this.request("PUT", `entries/${id}/bookmark`);
  }

  private entryQueryString(
    f: Partial<{
      status: string;
      offset: number;
      limit: number;
      order: string;
      direction: string;
      before: number;
      after: number;
      beforeEntryId: number;
      afterEntryId: number;
      starred: boolean;
    }>,
  ): string {
    const p = new URLSearchParams();
    if (f.status !== undefined) p.set("status", f.status);
    if (f.offset !== undefined) p.set("offset", String(f.offset));
    if (f.limit !== undefined) p.set("limit", String(f.limit));
    if (f.order !== undefined) p.set("order", f.order);
    if (f.direction !== undefined) p.set("direction", f.direction);
    if (f.before !== undefined) p.set("before", String(f.before));
    if (f.after !== undefined) p.set("after", String(f.after));
    if (f.beforeEntryId !== undefined) p.set("before_entry_id", String(f.beforeEntryId));
    if (f.afterEntryId !== undefined) p.set("after_entry_id", String(f.afterEntryId));
    if (f.starred !== undefined) p.set("starred", String(f.starred));
    const s = p.toString();
    return s ? `?${s}` : "";
  }
}