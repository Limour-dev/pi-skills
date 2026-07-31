/**
 * PubMed data source via NCBI E-utilities API — pure TypeScript.
 *
 * Faithful port of
 *   https://github.com/Yuan1z0825/nature-skills/blob/main/skills/nature-academic-search/mcp-server/sources/pubmed.py
 * (Apache-2.0) to dependency-free TypeScript. Zero runtime dependencies:
 * uses the built-in `fetch` (Node >= 18), `performance.now()` for
 * monotonic throttling, and the bundled minimal XML parser in ./xml.ts
 * (Node has no built-in XML parser).
 *
 * Run anywhere Node can run TypeScript directly (>= 22.6 with
 * `--experimental-strip-types`, >= 23.6 by default) or via `npx tsx`.
 */

import { readFileSync } from "node:fs";

import { parseXml } from "./xml.ts";
import type { XmlElement } from "./xml.ts";

export const BASE_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/";
export const SOURCE_NAME = "pubmed";

// NCBI rate limits: 3 req/s without API key, 10 req/s with key.
const REQ_INTERVAL_WITH_KEY_MS = 110;
const REQ_INTERVAL_WITHOUT_KEY_MS = 350;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class DataSourceError extends Error {
  readonly source: string;
  readonly originalError?: unknown;

  constructor(source: string, message: string, originalError?: unknown) {
    super(`[${source}] ${message}`);
    this.name = "DataSourceError";
    this.source = source;
    this.originalError = originalError;
  }
}

// ---------------------------------------------------------------------------
// Result types (the "unified result dict" from the Python original)
// ---------------------------------------------------------------------------

export interface UnifiedResult {
  title: string;
  authors: string[];
  year: number | null;
  pmid: string;
  doi: string;
  journal: string;
  abstract: string;
  source: typeof SOURCE_NAME;
}

export interface SearchResponse {
  total: number;
  query: string;
  results: UnifiedResult[];
}

export interface MeshDescriptor {
  name: string;
  mesh_id: string;
  ui: string;
}

export interface MeshLookupResponse {
  term: string;
  results: MeshDescriptor[];
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface PubMedConfig {
  /** Email sent to NCBI (requested by NCBI etiquette; also improves throughput). */
  email?: string;
  /** NCBI API key — raises the rate limit to 10 req/s. */
  apiKey?: string;
  /** Cap on `rows` per search request (default 50). */
  maxRows?: number;
  /** Throw when no email is configured (default true, matching the original). */
  requireEmail?: boolean;
  /** Path to a JSON config file shaped like `{ "pubmed": { "email", "api_key", "max_rows" } }`. */
  configPath?: string;
  /** Per-request timeout in ms (default 30_000). */
  timeoutMs?: number;
}

interface FileConfig {
  pubmed?: {
    email?: unknown;
    api_key?: unknown;
    max_rows?: unknown;
  };
}

function toPositiveInt(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

// ---------------------------------------------------------------------------
// Logging (JSON lines to stderr, like the original's JSONFormatter)
// ---------------------------------------------------------------------------

function log(level: string, message: string, extra: Record<string, unknown> = {}): void {
  const entry: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level,
    source: SOURCE_NAME,
    message,
    ...extra,
  };
  process.stderr.write(`${JSON.stringify(entry)}\n`);
}

// ---------------------------------------------------------------------------
// Throttling (mirrors the Python module-level _throttle)
// ---------------------------------------------------------------------------

let lastRequestTsMs = 0;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function throttle(apiKey: string): Promise<void> {
  const intervalMs = apiKey ? REQ_INTERVAL_WITH_KEY_MS : REQ_INTERVAL_WITHOUT_KEY_MS;
  const elapsed = performance.now() - lastRequestTsMs;
  if (elapsed < intervalMs) {
    await sleep(intervalMs - elapsed);
  }
  lastRequestTsMs = performance.now();
}

// ---------------------------------------------------------------------------
// Article parsing
// ---------------------------------------------------------------------------

/**
 * Parse a single `PubmedArticle` XML element into the unified result dict.
 * Mirrors `_parse_article` in the Python original.
 */
function parseArticle(article: XmlElement): UnifiedResult {
  const citation = article.find("MedlineCitation");
  if (citation === null) {
    throw new DataSourceError(SOURCE_NAME, "Missing MedlineCitation in article XML");
  }

  const pmidEl = citation.find("PMID");
  const pmid = pmidEl?.text.trim() ?? "";

  const art = citation.find("Article");
  if (art === null) {
    throw new DataSourceError(SOURCE_NAME, `Missing Article for PMID ${pmid}`);
  }

  // Title — textContent (itertext) is more robust than `.text` for titles
  // that contain inline markup.
  const titleEl = art.find("ArticleTitle");
  const title = titleEl ? titleEl.textContent.trim() : "";

  // Authors
  const authors: string[] = [];
  const authorList = art.find("AuthorList");
  if (authorList !== null) {
    for (const author of authorList.findAll("Author")) {
      const last = author.find("LastName");
      const fore = author.find("ForeName");
      if (last?.text) {
        let name = last.text.trim();
        if (fore?.text) name = `${name} ${fore.text.trim()}`;
        authors.push(name);
      } else {
        const collective = author.find("CollectiveName");
        if (collective?.text) authors.push(collective.text.trim());
      }
    }
  }

  // Abstract — AbstractText may contain nested markup, so use textContent.
  const abstractParts: string[] = [];
  const abstractEl = art.find("Abstract");
  if (abstractEl !== null) {
    for (const textEl of abstractEl.findAll("AbstractText")) {
      const label = textEl.get("Label", "");
      const content = textEl.textContent.trim();
      if (label && content) abstractParts.push(`${label}: ${content}`);
      else if (content) abstractParts.push(content);
    }
  }
  const abstract = abstractParts.join(" ");

  // Journal + publication year
  const journalEl = art.find("Journal");
  let journal = "";
  let year: number | null = null;
  if (journalEl !== null) {
    const jTitle = journalEl.find("Title");
    if (jTitle?.text) journal = jTitle.text.trim();

    const issue = journalEl.find("JournalIssue");
    if (issue !== null) {
      const pubDate = issue.find("PubDate");
      if (pubDate !== null) {
        const yearEl = pubDate.find("Year");
        if (yearEl?.text) {
          const parsed = Number(yearEl.text.trim());
          if (Number.isInteger(parsed)) year = parsed;
        }
        if (year === null) {
          // "2024 Jan-Feb" style dates — extract the first 4-digit year.
          const medlineDate = pubDate.find("MedlineDate");
          if (medlineDate?.text) {
            const m = /\d{4}/.exec(medlineDate.text);
            if (m) year = Number(m[0]);
          }
        }
      }
    }
  }

  // DOI
  let doi = "";
  for (const eloi of art.findAll("ELocationID")) {
    if (eloi.get("EIdType") === "doi" && eloi.text) {
      doi = eloi.text.trim();
      break;
    }
  }

  return {
    title,
    authors,
    year,
    pmid,
    doi,
    journal,
    abstract,
    source: SOURCE_NAME,
  };
}

// ---------------------------------------------------------------------------
// PubMed source
// ---------------------------------------------------------------------------

export class PubMedSource {
  private readonly email: string;
  private readonly apiKey: string;
  private readonly maxRows: number;
  private readonly requireEmail: boolean;
  private readonly timeoutMs: number;

  /**
   * Config resolution order: explicit options > env vars
   * (PUBMED_EMAIL, NCBI_API_KEY, PUBMED_MAX_ROWS, PUBMED_CONFIG) >
   * JSON config file ({ "pubmed": { "email", "api_key", "max_rows" } }).
   */
  constructor(config: PubMedConfig = {}) {
    let fileCfg: FileConfig = {};
    const configPath = config.configPath ?? process.env.PUBMED_CONFIG;
    if (configPath) {
      try {
        fileCfg = JSON.parse(readFileSync(configPath, "utf8")) as FileConfig;
      } catch (err) {
        log("warning", `Failed to read config file ${configPath}: ${(err as Error).message}`);
      }
    }
    const pubmed = fileCfg.pubmed ?? {};

    this.email =
      config.email ?? process.env.PUBMED_EMAIL ?? String(pubmed.email ?? "");
    this.apiKey =
      config.apiKey ?? process.env.NCBI_API_KEY ?? String(pubmed.api_key ?? "");
    this.maxRows = toPositiveInt(
      config.maxRows ?? process.env.PUBMED_MAX_ROWS ?? pubmed.max_rows,
      50,
    );
    this.requireEmail = config.requireEmail ?? true;
    this.timeoutMs = config.timeoutMs ?? 30_000;
  }

  private ensureEmail(): void {
    if (this.requireEmail && !this.email) {
      throw new DataSourceError(
        SOURCE_NAME,
        "PubMed email not configured. Set PUBMED_EMAIL env var, pass { email } to the constructor, or set pubmed.email in a JSON config file.",
      );
    }
  }

  /** Raise if NCBI returned an <Error>/<ERROR> element (e.g. rate-limit). */
  private raiseEutilsError(root: XmlElement): void {
    const err = root.find("Error") ?? root.find("ERROR");
    if (err && err.textContent.trim()) {
      throw new DataSourceError(
        SOURCE_NAME,
        `NCBI E-utilities error: ${err.textContent.trim()}`,
      );
    }
  }

  /** Send a GET to an E-utilities endpoint with throttling and error handling. */
  private async get(
    endpoint: string,
    params: Record<string, string | number>,
  ): Promise<string> {
    await throttle(this.apiKey);

    const merged: Record<string, string> = {};
    for (const [k, v] of Object.entries(params)) merged[k] = String(v);
    if (this.email) merged.email = this.email;
    if (this.apiKey) merged.api_key = this.apiKey;

    const url = `${BASE_URL}${endpoint}?${new URLSearchParams(merged).toString()}`;
    let resp: Response;
    try {
      resp = await fetch(url, { signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new DataSourceError(SOURCE_NAME, `Request timed out: ${url}`, err);
      }
      throw new DataSourceError(SOURCE_NAME, `Request failed: ${url}`, err);
    }
    if (!resp.ok) {
      throw new DataSourceError(SOURCE_NAME, `HTTP ${resp.status} from ${url}`);
    }
    return resp.text();
  }

  /**
   * Search PubMed and return structured results.
   *
   * @param query PubMed search query string (Boolean / MeSH / field tags).
   * @param rows  Number of results to return (capped at maxRows, default 5).
   * @param sort  "relevance" (Best Match) or "date" (Most Recent).
   */
  async search(
    query: string,
    rows = 5,
    sort: "relevance" | "date" = "relevance",
  ): Promise<SearchResponse> {
    if (!query || !query.trim()) {
      throw new DataSourceError(SOURCE_NAME, "Empty search query");
    }
    this.ensureEmail();

    rows = Math.min(rows, this.maxRows);
    const sortParam = sort === "relevance" ? "relevance" : "pub_date";

    // Step 1: esearch to get WebEnv + query_key
    const searchParams: Record<string, string | number> = {
      db: "pubmed",
      term: query.trim(),
      retmax: rows,
      usehistory: "y",
      retmode: "xml",
      sort: sortParam,
    };
    const root = parseXml(await this.get("esearch.fcgi", searchParams));
    this.raiseEutilsError(root);

    const countEl = root.find("Count");
    const total = countEl?.text ? Number(countEl.text.trim()) : 0;

    const webEnvEl = root.find("WebEnv");
    const queryKeyEl = root.find("QueryKey");
    if (!webEnvEl?.text || !queryKeyEl?.text) {
      // No results
      return { total: 0, query, results: [] };
    }
    const webEnv = webEnvEl.text.trim();
    const queryKey = queryKeyEl.text.trim();

    // Step 2: efetch to get article details
    const fetchParams: Record<string, string | number> = {
      db: "pubmed",
      query_key: queryKey,
      WebEnv: webEnv,
      retmax: rows,
      retmode: "xml",
      rettype: "abstract",
    };
    const fetchRoot = parseXml(await this.get("efetch.fcgi", fetchParams));
    this.raiseEutilsError(fetchRoot);

    const results: UnifiedResult[] = [];
    for (const article of fetchRoot.findAll("PubmedArticle")) {
      try {
        results.push(parseArticle(article));
      } catch (err) {
        if (err instanceof DataSourceError) {
          log("warning", `Failed to parse article: ${err.message}`);
          continue;
        }
        throw err;
      }
    }

    return { total, query, results };
  }

  /**
   * Fetch a single article by PMID.
   *
   * @throws DataSourceError if the PMID is invalid or the article is not found.
   */
  async getByPmid(pmid: string): Promise<UnifiedResult> {
    if (!pmid || !/^\d+$/.test(pmid.trim())) {
      throw new DataSourceError(SOURCE_NAME, `Invalid PMID: ${pmid}`);
    }
    this.ensureEmail();

    const fetchParams: Record<string, string | number> = {
      db: "pubmed",
      id: pmid.trim(),
      retmode: "xml",
      rettype: "abstract",
    };
    const root = parseXml(await this.get("efetch.fcgi", fetchParams));
    this.raiseEutilsError(root);

    const article = root.find("PubmedArticle");
    if (article === null) {
      throw new DataSourceError(SOURCE_NAME, `PMID ${pmid} not found`);
    }
    return parseArticle(article);
  }

  /**
   * Look up a MeSH descriptor by term, returning matching descriptor
   * names and unique IDs (UI).
   */
  async lookupMesh(term: string): Promise<MeshLookupResponse> {
    if (!term || !term.trim()) {
      throw new DataSourceError(SOURCE_NAME, "Empty MeSH lookup term");
    }
    this.ensureEmail();

    // esearch against the MeSH database
    const searchParams: Record<string, string | number> = {
      db: "mesh",
      term: term.trim(),
      retmax: 10,
      retmode: "xml",
    };
    const root = parseXml(await this.get("esearch.fcgi", searchParams));
    this.raiseEutilsError(root);

    const idList = root.find("IdList");
    const ids: string[] = [];
    if (idList !== null) {
      for (const idEl of idList.findAll("Id")) {
        if (idEl.text) ids.push(idEl.text.trim());
      }
    }
    if (ids.length === 0) {
      return { term, results: [] };
    }

    // esummary for descriptor details. NOTE: the MeSH database has NO XML
    // efetch (it only serves plain text), so the original Python's
    // efetch+DescriptorRecord parsing would crash against the live API.
    // esummary returns the same structured records; we read the first
    // DS_MeshTerms entry as the descriptor name and the DocSum Id as UI.
    const fetchParams: Record<string, string | number> = {
      db: "mesh",
      id: ids.join(","),
      retmode: "xml",
    };
    const fetchRoot = parseXml(await this.get("esummary.fcgi", fetchParams));
    this.raiseEutilsError(fetchRoot);

    const results: MeshDescriptor[] = [];
    for (const docSum of fetchRoot.findAll("DocSum")) {
      const uiEl = docSum.find("Id");
      const ui = uiEl?.text.trim() ?? "";
      let name = "";
      for (const item of docSum.findAll("Item")) {
        if (item.get("Name") === "DS_MeshTerms") {
          name = item.findAll("Item")[0]?.text.trim() ?? "";
          break;
        }
      }
      if (name) results.push({ name, mesh_id: ui, ui });

    }

    return { term, results };
  }
}

