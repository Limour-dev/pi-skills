/**
 * Typed Miniflux v2 API client.
 */
import { MinifluxConfig, normalizeBaseUrl } from "./config.js";
import { MinifluxError } from "./error.js";
import type {
  DiscoverResult,
  EntryFilters,
  EntryListResponse,
  EntryStatus,
  FeedIcon,
  MinifluxCategory,
  MinifluxEntry,
  MinifluxFeed,
  MinifluxUser,
  UpdateFeedFields,
} from "./types.js";
import { ENTRY_STATUSES } from "./types.js";

const DEFAULT_TIMEOUT_MS = 30_000;

/** Build the `?…` query string for the entry listing endpoints. */
export function buildEntryQuery(filters: EntryFilters = {}): string {
  const p = new URLSearchParams();
  if (filters.status !== undefined) p.set("status", filters.status);
  if (filters.offset !== undefined) p.set("offset", String(filters.offset));
  if (filters.limit !== undefined) p.set("limit", String(filters.limit));
  if (filters.order !== undefined) p.set("order", filters.order);
  if (filters.direction !== undefined) p.set("direction", filters.direction);
  if (filters.before !== undefined) p.set("before", String(filters.before));
  if (filters.after !== undefined) p.set("after", String(filters.after));
  if (filters.beforeEntryId !== undefined) p.set("before_entry_id", String(filters.beforeEntryId));
  if (filters.afterEntryId !== undefined) p.set("after_entry_id", String(filters.afterEntryId));
  if (filters.starred !== undefined) p.set("starred", String(filters.starred));
  const qs = p.toString();
  return qs ? `?${qs}` : "";
}

/** Map camelCase update-feed fields to the snake_case API body. */
export function buildUpdateFeedBody(fields: UpdateFeedFields): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (fields.title !== undefined) body.title = fields.title;
  if (fields.categoryId !== undefined) body.category_id = fields.categoryId;
  if (fields.feedUrl !== undefined) body.feed_url = fields.feedUrl;
  if (fields.siteUrl !== undefined) body.site_url = fields.siteUrl;
  if (fields.userAgent !== undefined) body.user_agent = fields.userAgent;
  return body;
}

export class MinifluxClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(config: MinifluxConfig) {
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  // ---- Read ----

  /**
   * Check that the instance is reachable and credentials work.
   * Falls back to the base URL only when `/v1/healthcheck` is not found
   * (older Miniflux versions), so auth errors are still reported.
   */
  async healthcheck(): Promise<void> {
    try {
      await this.request<void>("GET", "healthcheck");
      return;
    } catch (err) {
      const missing = err instanceof MinifluxError && err.status === 404;
      const network = err instanceof MinifluxError && err.status === undefined;
      if (!missing && !network) throw err;
    }
    await this.probeBaseUrl();
  }

  getMe(): Promise<MinifluxUser> {
    return this.request("GET", "me");
  }

  getUserById(id: number): Promise<MinifluxUser> {
    return this.request("GET", `users/${id}`);
  }

  getUserByName(username: string): Promise<MinifluxUser> {
    return this.request("GET", `users/${encodeURIComponent(username)}`);
  }

  getFeeds(): Promise<MinifluxFeed[]> {
    return this.request("GET", "feeds");
  }

  getFeed(id: number): Promise<MinifluxFeed> {
    return this.request("GET", `feeds/${id}`);
  }

  getFeedIcon(id: number): Promise<FeedIcon> {
    return this.request("GET", `feeds/${id}/icon`);
  }

  discover(url: string): Promise<DiscoverResult[]> {
    return this.request("POST", "discover", { url });
  }

  getEntries(filters: EntryFilters = {}): Promise<EntryListResponse> {
    return this.request("GET", `entries${buildEntryQuery(filters)}`);
  }

  getEntry(id: number): Promise<MinifluxEntry> {
    return this.request("GET", `entries/${id}`);
  }

  getFeedEntries(feedId: number, filters: EntryFilters = {}): Promise<EntryListResponse> {
    return this.request("GET", `feeds/${feedId}/entries${buildEntryQuery(filters)}`);
  }

  getCategories(): Promise<MinifluxCategory[]> {
    return this.request("GET", "categories");
  }

  /** Export all feeds as raw OPML XML. */
  exportOpml(): Promise<string> {
    return this.requestRaw("GET", "export/opml");
  }

  // ---- Write ----

  /** Import feeds from raw OPML XML. */
  importOpml(opml: string): Promise<void> {
    return this.requestRaw("POST", "import/opml", opml).then(() => undefined);
  }

  createCategory(title: string): Promise<MinifluxCategory> {
    return this.request("POST", "categories", { title });
  }

  updateCategory(id: number, title: string): Promise<MinifluxCategory> {
    return this.request("PUT", `categories/${id}`, { title });
  }

  deleteCategory(id: number): Promise<void> {
    return this.request("DELETE", `categories/${id}`);
  }

  createFeed(feedUrl: string, categoryId: number): Promise<{ feed_id: number }> {
    return this.request("POST", "feeds", { feed_url: feedUrl, category_id: categoryId });
  }

  updateFeed(id: number, fields: UpdateFeedFields): Promise<MinifluxFeed> {
    return this.request("PUT", `feeds/${id}`, buildUpdateFeedBody(fields));
  }

  deleteFeed(id: number): Promise<void> {
    return this.request("DELETE", `feeds/${id}`);
  }

  refreshFeed(id: number): Promise<void> {
    return this.request("PUT", `feeds/${id}/refresh`);
  }

  updateEntryStatus(entryIds: number[], status: EntryStatus): Promise<void> {
    if (!ENTRY_STATUSES.includes(status)) {
      throw new MinifluxError(`Invalid entry status: ${status} (expected one of ${ENTRY_STATUSES.join(", ")})`);
    }
    return this.request("PUT", "entries", { entry_ids: entryIds, status });
  }

  toggleBookmark(id: number): Promise<void> {
    return this.request("PUT", `entries/${id}/bookmark`);
  }

  // ---- Internals ----

  private endpoint(path: string): string {
    return `${this.baseUrl}/v1/${path.replace(/^\/+/, "")}`;
  }

  /** Fetch with a timeout, wrapping everything into MinifluxError. */
  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new MinifluxError(`Request timed out after ${this.timeoutMs}ms: ${init.method ?? "GET"} ${url}`);
      }
      throw new MinifluxError(`Network error on ${init.method ?? "GET"} ${url}: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchWithTimeout(this.endpoint(path), {
      method,
      headers: {
        "X-Auth-Token": this.apiKey,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return this.parseResponse<T>(res, method, path, true);
  }

  /** For endpoints that carry raw text (OPML export/import), not JSON. */
  private async requestRaw(method: string, path: string, rawBody?: string): Promise<string> {
    const res = await this.fetchWithTimeout(this.endpoint(path), {
      method,
      headers: {
        "X-Auth-Token": this.apiKey,
        ...(rawBody !== undefined ? { "Content-Type": "text/xml" } : {}),
      },
      body: rawBody,
    });
    return this.parseResponse<string>(res, method, path, false);
  }

  private async parseResponse<T>(res: Response, method: string, path: string, parseJson: boolean): Promise<T> {
    if (!res.ok) {
      let detail = "";
      try {
        const j = (await res.json()) as { error_message?: string; message?: string };
        detail = j.error_message ?? j.message ?? "";
      } catch {
        /* body is not JSON; ignore */
      }
      throw new MinifluxError(
        `Miniflux API ${res.status} ${res.statusText} on ${method} /v1/${path}${detail ? `: ${detail}` : ""}`,
        res.status,
      );
    }

    if (res.status === 204 || res.headers.get("content-length") === "0") {
      return undefined as T;
    }
    const text = await res.text();
    if (!parseJson) return text as T;
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new MinifluxError(`Invalid JSON in response from ${method} /v1/${path}`);
    }
  }

  /** Fallback reachability probe used by healthcheck(). */
  private async probeBaseUrl(): Promise<void> {
    const res = await this.fetchWithTimeout(`${this.baseUrl}/`, { method: "GET" });
    if (!res.ok) {
      throw new MinifluxError(`Miniflux returned HTTP ${res.status} at ${this.baseUrl}/`, res.status);
    }
  }
}
