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

import {
  mkdirSync,
  readFileSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { parseXml } from "./xml.ts";
import type { XmlElement } from "./xml.ts";

export const BASE_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/";
export const SOURCE_NAME = "pubmed";

// NCBI rate limits: 3 req/s without API key, 10 req/s with key.
const REQ_INTERVAL_WITH_KEY_MS = 110;
const REQ_INTERVAL_WITHOUT_KEY_MS = 350;

// Retry policy for transient failures (429 / 5xx / timeouts).
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 8_000;

// Cross-process lock helpers (best effort; never fatal).
const LOCK_STALE_MS = 30_000;

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
  /** Full journal title, e.g. "British journal of cancer". */
  journal: string;
  /** ISO abbreviation from PubMed, e.g. "Br J Cancer". */
  journal_abbrev: string;
  volume: string;
  issue: string;
  /** Medline pagination, e.g. "695-9". */
  pages: string;
  issn: string;
  pubtype: string[];
  language: string;
  /** Descriptor names, with qualifiers appended as "Descriptor/qualifier". */
  mesh_terms: string[];
  abstract: string;
  source: typeof SOURCE_NAME;
}

export interface SearchResponse {
  total: number;
  query: string;
  /** NCBI's translation of the query (what actually ran). */
  query_translation: string;
  /** Actionable warnings: QuotedPhraseNotFound / PhraseIgnored / FieldNotFound / … */
  warnings: string[];
  /** True when `--rows` exceeded `maxRows` and the page was capped. */
  truncated?: boolean;
  results: UnifiedResult[];
  /** Present for `search --ids-only`: the PMIDs on this page. */
  pmids?: string[];
}

export interface MeshDescriptor {
  /** Descriptor name (first DS_MeshTerms entry). */
  name: string;
  /** Raw MeSH internal numeric UID, e.g. "68009203". */
  mesh_uid: string;
  /** Reconstructed descriptor UI, e.g. "D009203" — use this in PubMed queries. */
  descriptor_ui: string;
  /** Backwards-compatible alias of `descriptor_ui`. */
  ui: string;
  /** MeSH tree numbers (may be empty). */
  tree_numbers: string[];
  /** MeSH scope note (may be empty). */
  scope_note: string;
}

export interface MeshLookupResponse {
  term: string;
  results: MeshDescriptor[];
}

export interface SearchOptions {
  /** Zero-based result offset (NCBI `retstart`). */
  offset?: number;
  /** Only run esearch; return `pmids[]` without fetching details. */
  idsOnly?: boolean;
  /** Only run esearch; return `total` (and warnings) without any details. */
  countOnly?: boolean;
  /** Only run esearch; return `query_translation` + `warnings`. */
  explain?: boolean;
}

export interface GetOptions {
  /** Skip the local PMID cache. */
  noCache?: boolean;
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
  /** Enable the on-disk PMID cache (default true). */
  cache?: boolean;
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
// Throttling (cross-process via a lock file, with in-process fallback)
// ---------------------------------------------------------------------------

let lastRequestTsMs = 0;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Root cache dir shared by the throttle lock and the PMID cache. */
function cacheRoot(): string | null {
  try {
    const base =
      process.env.PUBMED_CACHE_DIR ??
      process.env.XDG_CACHE_HOME ??
      join(homedir(), ".cache");
    return join(base, "pubmed-search");
  } catch {
    return null;
  }
}

/** In-process throttle: used when the cache dir is unavailable. */
async function throttleInProcess(intervalMs: number): Promise<void> {
  const elapsed = performance.now() - lastRequestTsMs;
  if (elapsed < intervalMs) await sleep(intervalMs - elapsed);
  lastRequestTsMs = performance.now();
}

/**
 * Enforce NCBI's rate limit across *all* local processes.
 *
 * The original module-level timestamp only throttled within one node process;
 * agents invoking the CLI in parallel bypassed it entirely. Here a lock
 * directory serialises processes and a shared timestamp file carries the
 * "last request" time between them. Falls back to in-process throttling if
 * the filesystem is not writable.
 */
async function throttle(apiKey: string): Promise<void> {
  const intervalMs = apiKey ? REQ_INTERVAL_WITH_KEY_MS : REQ_INTERVAL_WITHOUT_KEY_MS;
  const root = cacheRoot();
  if (root === null) {
    await throttleInProcess(intervalMs);
    return;
  }

  let dirOk = true;
  try {
    mkdirSync(root, { recursive: true });
  } catch {
    dirOk = false;
  }
  if (!dirOk) {
    await throttleInProcess(intervalMs);
    return;
  }

  const lockDir = join(root, "ratelimit.lock");
  const stampFile = join(root, "ratelimit.stamp");
  const deadline = Date.now() + LOCK_STALE_MS;
  let locked = false;

  while (!locked) {
    try {
      mkdirSync(lockDir);
      locked = true;
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") break;
      // Reclaim a stale lock left by a crashed process.
      try {
        const st = statSync(lockDir);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          rmdirSync(lockDir);
          continue;
        }
      } catch {
        // Lock vanished between calls — retry immediately.
        continue;
      }
      if (Date.now() > deadline) break;
      await sleep(15 + Math.random() * 35);
    }
  }

  if (!locked) {
    await throttleInProcess(intervalMs);
    return;
  }

  try {
    let last = 0;
    try {
      last = Number(readFileSync(stampFile, "utf8")) || 0;
    } catch {
      last = 0;
    }
    const elapsed = Date.now() - last;
    if (elapsed < intervalMs) await sleep(intervalMs - elapsed);
    writeFileSync(stampFile, String(Date.now()));
  } finally {
    try {
      rmdirSync(lockDir);
    } catch {
      // Already gone; nothing to do.
    }
  }
  lastRequestTsMs = performance.now();
}

// ---------------------------------------------------------------------------
// Article parsing
// ---------------------------------------------------------------------------

function textOf(el: XmlElement | null): string {
  return el?.text.trim() ?? "";
}

/** Collect `DescriptorName` + qualifiers into "Descriptor/qualifier" strings. */
function parseMeshTerms(citation: XmlElement): string[] {
  const terms: string[] = [];
  const list = citation.find("MeshHeadingList");
  if (list === null) return terms;
  for (const heading of list.findAll("MeshHeading")) {
    const descriptor = textOf(heading.find("DescriptorName"));
    if (!descriptor) continue;
    const qualifiers: string[] = [];
    for (const q of heading.findAll("QualifierName")) {
      const name = q.text.trim();
      if (name) qualifiers.push(name);
    }
    terms.push(qualifiers.length > 0 ? `${descriptor}/${qualifiers.join("/")}` : descriptor);
  }
  return terms;
}

/** Reconstruct a MeSH descriptor UI from an internal numeric UID. */
export function meshUidToDescriptorUi(uid: string): string {
  const digits = uid.replace(/\D/g, "");
  if (digits.length < 3) return uid;
  const prefix2 = digits.slice(0, 2);
  const head =
    prefix2 === "68" ? "D" : prefix2 === "67" ? "C" : prefix2 === "66" ? "Q" : prefix2 === "65" ? "V" : "D";
  const tail = digits.slice(-6).padStart(6, "0");
  return `${head}${tail}`;
}

/**
 * Parse a single `PubmedArticle` XML element into the unified result dict.
 * Mirrors `_parse_article` in the Python original, extended with the
 * bibliographic fields needed to build a reference list.
 */
function parseArticle(article: XmlElement): UnifiedResult {
  const citation = article.find("MedlineCitation");
  if (citation === null) {
    throw new DataSourceError(SOURCE_NAME, "Missing MedlineCitation in article XML");
  }

  const pmid = textOf(citation.find("PMID"));

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

  // Journal + issue + publication year
  const journalEl = art.find("Journal");
  let journal = "";
  let journalAbbrev = "";
  let issn = "";
  let volume = "";
  let issue = "";
  let year: number | null = null;
  if (journalEl !== null) {
    journal = textOf(journalEl.find("Title"));
    journalAbbrev = textOf(journalEl.find("ISOAbbreviation"));
    issn = textOf(journalEl.find("ISSN"));

    const issueEl = journalEl.find("JournalIssue");
    if (issueEl !== null) {
      volume = textOf(issueEl.find("Volume"));
      issue = textOf(issueEl.find("Issue"));
      const pubDate = issueEl.find("PubDate");
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

  // Pagination
  const pagination = art.find("Pagination");
  let pages = textOf(pagination?.find("MedlinePgn") ?? null);
  if (!pages && pagination !== null) {
    const start = textOf(pagination.find("StartPage"));
    const end = textOf(pagination.find("EndPage"));
    if (start) pages = end ? `${start}-${end}` : start;
  }

  // Publication types / language / MeSH
  const pubtype: string[] = [];
  const ptList = art.find("PublicationTypeList");
  if (ptList !== null) {
    for (const pt of ptList.findAll("PublicationType")) {
      const name = pt.text.trim();
      if (name) pubtype.push(name);
    }
  }
  const language = textOf(art.find("Language"));
  const meshTerms = parseMeshTerms(citation);

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
    journal_abbrev: journalAbbrev,
    volume,
    issue,
    pages,
    issn,
    pubtype,
    language,
    mesh_terms: meshTerms,
    abstract,
    source: SOURCE_NAME,
  };
}

/**
 * Format a result as a reference-list-ready citation string:
 *   Authors. Title. Journal. Year;Volume(Issue):Pages. doi:… PMID:…
 */
export function formatCitation(result: UnifiedResult): string {
  const parts: string[] = [];
  if (result.authors.length > 0) parts.push(`${result.authors.join(", ")}.`);
  if (result.title) parts.push(`${result.title.replace(/\.\s*$/, "")}.`);

  const journal = result.journal_abbrev || result.journal;
  const year = result.year ?? "";
  let locator = "";
  if (result.volume) {
    locator = String(result.volume);
    if (result.issue) locator += `(${result.issue})`;
  }
  if (result.pages) locator += `${locator ? ":" : ""}${result.pages}`;
  if (journal || locator) {
    let segment = journal;
    if (locator) segment += `${segment ? ". " : ""}${year};${locator}`;
    else if (year) segment += `${segment ? ". " : ""}${year}`;
    parts.push(segment.endsWith(".") ? segment : `${segment}.`);
  } else if (year) {
    parts.push(`${year}.`);
  }

  if (result.doi) parts.push(`doi:${result.doi}.`);
  if (result.pmid) parts.push(`PMID: ${result.pmid}.`);
  return parts.join(" ").trim();
}

// ---------------------------------------------------------------------------
// Warnings / query translation
// ---------------------------------------------------------------------------

function extractWarnings(root: XmlElement): string[] {
  const out: string[] = [];
  const warningList = root.find("WarningList");
  if (warningList === null) return out;
  for (const child of warningList.children) {
    const text = child.textContent.trim();
    if (!text) continue;
    out.push(child.name === "OutputMessage" ? text : `${child.name}: ${text}`);
  }
  return out;
}

function extractQueryTranslation(root: XmlElement): string {
  return root.find("QueryTranslation")?.textContent.trim() ?? "";
}

function extractIds(root: XmlElement, tag: string): string[] {
  const ids: string[] = [];
  const list = root.find(tag);
  if (list === null) return ids;
  for (const el of list.children) {
    const text = el.textContent.trim();
    if (text) ids.push(text);
  }
  return ids;
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
  private readonly cacheEnabled: boolean;

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
    this.cacheEnabled = config.cache ?? true;
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

  /** Parse a `Retry-After` header (seconds or HTTP date). */
  private static parseRetryAfter(value: string | null): number | null {
    if (!value) return null;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, RETRY_MAX_MS);
    const date = Date.parse(value);
    if (Number.isFinite(date)) {
      const delta = date - Date.now();
      if (delta > 0) return Math.min(delta, RETRY_MAX_MS);
    }
    return null;
  }

  /**
   * Send a GET to an E-utilities endpoint with throttling and error handling.
   * Transient failures (429 / 500-504 / timeouts / network errors) are retried
   * with exponential backoff, honouring `Retry-After` when present.
   */
  private async get(
    endpoint: string,
    params: Record<string, string | number>,
  ): Promise<string> {
    const merged: Record<string, string> = {};
    for (const [k, v] of Object.entries(params)) merged[k] = String(v);
    if (this.email) merged.email = this.email;
    if (this.apiKey) merged.api_key = this.apiKey;
    const url = `${BASE_URL}${endpoint}?${new URLSearchParams(merged).toString()}`;

    let attempt = 0;
    for (;;) {
      await throttle(this.apiKey);

      let resp: Response | null = null;
      let failure: unknown = null;
      try {
        resp = await fetch(url, { signal: AbortSignal.timeout(this.timeoutMs) });
      } catch (err) {
        failure = err;
      }

      if (resp !== null && resp.ok) return resp.text();

      const status = resp?.status ?? 0;
      const retryable =
        resp === null ||
        status === 429 ||
        status === 408 ||
        (status >= 500 && status <= 504);

      if (retryable && attempt < MAX_RETRIES) {
        attempt += 1;
        const retryAfter =
          resp !== null ? PubMedSource.parseRetryAfter(resp.headers.get("retry-after")) : null;
        const delay = retryAfter ?? Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS);
        const what = resp === null
          ? (failure instanceof Error ? failure.name : "network error")
          : `HTTP ${status}`;
        log("warning", `${what} from ${endpoint}; retrying in ${delay}ms (attempt ${attempt}/${MAX_RETRIES})`);
        await sleep(delay);
        continue;
      }

      if (resp === null) {
        if (failure instanceof Error && failure.name === "TimeoutError") {
          throw new DataSourceError(SOURCE_NAME, `Request timed out: ${url}`, failure);
        }
        throw new DataSourceError(SOURCE_NAME, `Request failed: ${url}`, failure);
      }
      throw new DataSourceError(SOURCE_NAME, `HTTP ${resp.status} from ${url}`);
    }
  }

  // -- PMID cache ----------------------------------------------------------

  private cacheDir(): string | null {
    if (!this.cacheEnabled) return null;
    const root = cacheRoot();
    return root === null ? null : join(root, "pmid");
  }

  private readCache(pmid: string): UnifiedResult | null {
    const dir = this.cacheDir();
    if (dir === null) return null;
    const file = join(dir, `${pmid}.json`);
    try {
      const raw = readFileSync(file, "utf8");
      const parsed = JSON.parse(raw) as { cached_at?: number; result?: UnifiedResult };
      const cachedAt = parsed.cached_at ?? 0;
      const oneWeek = 7 * 24 * 60 * 60 * 1000;
      if (Date.now() - cachedAt > oneWeek) return null;
      return parsed.result ?? null;
    } catch {
      return null;
    }
  }

  private writeCache(result: UnifiedResult): void {
    const dir = this.cacheDir();
    if (dir === null || !result.pmid) return;
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, `${result.pmid}.json`),
        JSON.stringify({ cached_at: Date.now(), result }),
      );
    } catch {
      // Cache is best-effort.
    }
  }

  // -- Search --------------------------------------------------------------

  /**
   * Search PubMed and return structured results.
   *
   * @param query PubMed search query string (Boolean / MeSH / field tags).
   * @param rows  Number of results to return (capped at maxRows, default 5).
   * @param sort  "relevance" (Best Match) or "date" (Most Recent).
   * @param options offset / idsOnly / countOnly / explain.
   */
  async search(
    query: string,
    rows = 5,
    sort: "relevance" | "date" = "relevance",
    options: SearchOptions = {},
  ): Promise<SearchResponse> {
    if (!query || !query.trim()) {
      throw new DataSourceError(SOURCE_NAME, "Empty search query");
    }
    this.ensureEmail();

    const requested = Math.max(1, Math.floor(rows));
    let truncated = false;
    if (requested > this.maxRows) {
      truncated = true;
      log(
        "warning",
        `--rows ${requested} exceeds maxRows ${this.maxRows}; returning at most ${this.maxRows} results. Use --max-rows to raise the cap or --offset to page.`,
      );
    }
    const effectiveRows = Math.min(requested, this.maxRows);
    const offset = Math.max(0, Math.floor(options.offset ?? 0));
    const sortParam = sort === "relevance" ? "relevance" : "pub_date";
    const lightMode = Boolean(options.idsOnly || options.countOnly || options.explain);

    // Step 1: esearch
    const searchParams: Record<string, string | number> = {
      db: "pubmed",
      term: query.trim(),
      retmax: lightMode && !options.idsOnly ? 0 : effectiveRows,
      retstart: offset,
      usehistory: "y",
      retmode: "xml",
      sort: sortParam,
    };
    const root = parseXml(await this.get("esearch.fcgi", searchParams));
    this.raiseEutilsError(root);

    const total = Number(textOf(root.find("Count"))) || 0;
    const queryTranslation = extractQueryTranslation(root);
    const warnings = extractWarnings(root);
    const idList = extractIds(root, "IdList");
    if (warnings.length > 0) log("warning", `Search warnings: ${warnings.join("; ")}`);

    const base: SearchResponse = {
      total,
      query,
      query_translation: queryTranslation,
      warnings,
      results: [],
    };
    if (truncated) base.truncated = true;

    // 0 hits is a successful outcome, never an E-utilities error. (The old
    // code only short-circuited when WebEnv was missing — which NCBI always
    // returns even for 0 hits — and then ran efetch on an empty history set,
    // producing a misleading "Empty result - nothing to do" error.)
    if (options.countOnly || options.explain) return base;
    if (options.idsOnly) {
      base.pmids = idList;
      return base;
    }
    if (total === 0 || idList.length === 0) return base;

    const webEnv = textOf(root.find("WebEnv"));
    const queryKey = textOf(root.find("QueryKey"));

    // Step 2: efetch to get article details. Prefer the history set, but fall
    // back to an explicit id list if NCBI did not return one.
    const fetchParams: Record<string, string | number> = webEnv && queryKey
      ? {
          db: "pubmed",
          query_key: queryKey,
          WebEnv: webEnv,
          retmax: effectiveRows,
          retstart: offset,
          retmode: "xml",
          rettype: "abstract",
        }
      : {
          db: "pubmed",
          id: idList.join(","),
          retmode: "xml",
          rettype: "abstract",
        };
    const fetchRoot = parseXml(await this.get("efetch.fcgi", fetchParams));
    this.raiseEutilsError(fetchRoot);

    const results: UnifiedResult[] = [];
    for (const article of fetchRoot.findAll("PubmedArticle")) {
      try {
        const parsed = parseArticle(article);
        results.push(parsed);
        this.writeCache(parsed);
      } catch (err) {
        if (err instanceof DataSourceError) {
          log("warning", `Failed to parse article: ${err.message}`);
          continue;
        }
        throw err;
      }
    }

    base.results = results;
    return base;
  }

  // -- Fetch by PMID -------------------------------------------------------

  /**
   * Fetch one or more articles by PMID (batched into a single efetch request,
   * with a local week-long cache). Returns results in request order plus the
   * list of PMIDs NCBI could not resolve.
   */
  async getByPmids(
    pmids: string[],
    options: GetOptions = {},
  ): Promise<{ results: UnifiedResult[]; missing: string[] }> {
    const cleaned: string[] = [];
    for (const raw of pmids) {
      const pmid = raw.trim();
      if (!/^\d+$/.test(pmid)) {
        throw new DataSourceError(SOURCE_NAME, `Invalid PMID: ${raw}`);
      }
      if (!cleaned.includes(pmid)) cleaned.push(pmid);
    }
    if (cleaned.length === 0) {
      throw new DataSourceError(SOURCE_NAME, "No PMIDs given");
    }
    this.ensureEmail();

    const byId = new Map<string, UnifiedResult>();
    const toFetch: string[] = [];
    for (const pmid of cleaned) {
      const cached = options.noCache ? null : this.readCache(pmid);
      if (cached !== null) byId.set(pmid, cached);
      else toFetch.push(pmid);
    }

    // efetch accepts a comma-separated id list; chunk to stay well within URL limits.
    const CHUNK = 100;
    for (let i = 0; i < toFetch.length; i += CHUNK) {
      const chunk = toFetch.slice(i, i + CHUNK);
      const fetchParams: Record<string, string | number> = {
        db: "pubmed",
        id: chunk.join(","),
        retmode: "xml",
        rettype: "abstract",
      };
      const root = parseXml(await this.get("efetch.fcgi", fetchParams));
      this.raiseEutilsError(root);

      for (const article of root.findAll("PubmedArticle")) {
        const parsed = parseArticle(article);
        if (!parsed.pmid) continue;
        byId.set(parsed.pmid, parsed);
        this.writeCache(parsed);
      }
    }

    const results: UnifiedResult[] = [];
    const missing: string[] = [];
    for (const pmid of cleaned) {
      const found = byId.get(pmid);
      if (found) results.push(found);
      else missing.push(pmid);
    }
    return { results, missing };
  }

  /**
   * Fetch a single article by PMID.
   *
   * @throws DataSourceError if the PMID is invalid or the article is not found.
   */
  async getByPmid(pmid: string, options: GetOptions = {}): Promise<UnifiedResult> {
    const { results, missing } = await this.getByPmids([pmid], options);
    if (results.length === 0 || missing.length > 0) {
      throw new DataSourceError(SOURCE_NAME, `PMID ${pmid.trim()} not found`);
    }
    return results[0];
  }

  // -- MeSH ----------------------------------------------------------------

  /**
   * Look up MeSH descriptors by term. Results are ranked exact-match first;
   * each carries the reconstructed `descriptor_ui` (e.g. "D009203") to use in
   * PubMed `[MeSH Terms]` queries, plus tree numbers and scope note.
   */
  async lookupMesh(term: string, rows = 10): Promise<MeshLookupResponse> {
    if (!term || !term.trim()) {
      throw new DataSourceError(SOURCE_NAME, "Empty MeSH lookup term");
    }
    this.ensureEmail();

    const limit = Math.max(1, Math.floor(rows));
    // Fetch a few extra descriptors so exact/prefix matches still rank first
    // even when esearch returns them further down the list.
    const fetchLimit = Math.max(limit, 10);
    // esearch against the MeSH database
    const searchParams: Record<string, string | number> = {
      db: "mesh",
      term: term.trim(),
      retmax: fetchLimit,
      retmode: "xml",
    };
    const root = parseXml(await this.get("esearch.fcgi", searchParams));
    this.raiseEutilsError(root);

    const ids = extractIds(root, "IdList");
    if (ids.length === 0) {
      return { term, results: [] };
    }

    // esummary for descriptor details. NOTE: the MeSH database has NO XML
    // efetch (it only serves plain text), so the original Python's
    // efetch+DescriptorRecord parsing would crash against the live API.
    // esummary returns the same structured records.
    const fetchParams: Record<string, string | number> = {
      db: "mesh",
      id: ids.join(","),
      retmode: "xml",
    };
    const fetchRoot = parseXml(await this.get("esummary.fcgi", fetchParams));
    this.raiseEutilsError(fetchRoot);

    const results: MeshDescriptor[] = [];
    for (const docSum of fetchRoot.findAll("DocSum")) {
      const uid = textOf(docSum.find("Id"));
      let name = "";
      const treeNumbers: string[] = [];
      let scopeNote = "";
      for (const item of docSum.findAll("Item")) {
        const itemName = item.get("Name");
        if (itemName === "DS_MeshTerms" && !name) {
          const first = item.findAll("Item").find((x) => x.text.trim() !== "");
          name = first?.text.trim() ?? "";
        } else if (itemName === "DS_ScopeNote" && !scopeNote) {
          scopeNote = item.text.trim();
        }
      }
      // Tree numbers live under DS_IdxLinks/LinksType as <Item Name="TreeNum">.
      for (const treeEl of docSum.findAll(".//Item")) {
        if (treeEl.get("Name") !== "TreeNum") continue;
        const value = treeEl.text.trim();
        if (value && !treeNumbers.includes(value)) treeNumbers.push(value);
      }
      if (name) {
        const descriptorUi = meshUidToDescriptorUi(uid);
        results.push({
          name,
          mesh_uid: uid,
          descriptor_ui: descriptorUi,
          ui: descriptorUi,
          tree_numbers: treeNumbers,
          scope_note: scopeNote,
        });
      }
    }

    // Exact / prefix / substring match ranking, then alphabetical.
    const needle = term.trim().toLowerCase();
    const rank = (d: MeshDescriptor): number => {
      const n = d.name.toLowerCase();
      if (n === needle) return 0;
      if (n.startsWith(needle)) return 1;
      if (n.includes(needle)) return 2;
      return 3;
    };
    results.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));

    return { term, results: results.slice(0, limit) };

  }
}
