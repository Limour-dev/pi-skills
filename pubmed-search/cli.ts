#!/usr/bin/env node
/**
 * Command-line interface for the pure-TypeScript PubMed client.
 *
 * The ONLY supported way to use this skill is through this CLI, invoked via
 * bash — agents should never import src/pubmed.ts directly.
 *
 * Examples:
 *   node cli.ts search "glioblastoma[Title] AND MRI[Title]" --rows 5 --sort relevance
 *   node cli.ts search "heart failure" --count-only
 *   node cli.ts search "heart failure" --ids-only --rows 50
 *   node cli.ts get-by-pmid 28344011 --format citation
 *   node cli.ts get-by-pmid 22828611,28344011
 *   node cli.ts mesh "Alzheimer Disease" --rows 5
 *
 * Output contract:
 *   - success: result JSON on stdout (pretty-printed; add --compact for one line)
 *   - failure: human-readable error on stderr (or JSON with --json-errors)
 *   - exit codes: 0 = ok, 1 = runtime/data error, 2 = usage error
 */
import { PubMedSource, DataSourceError, formatCitation } from "./src/pubmed.ts";

const VERSION = "1.1.0";

// Set once args are parsed so the top-level catch can honour --json-errors.
let jsonErrors = false;

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let command = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      flags.help = true;
    } else if (a === "-v" || a === "--version") {
      flags.version = true;
    } else if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const name = a.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[name] = next;
          i++;
        } else {
          flags[name] = true;
        }
      }
    } else if (!command) {
      command = a;
    } else {
      positional.push(a);
    }
  }
  return { command, positional, flags };
}

function usage(): string {
  return `Usage:
  pubmed-search search <query> [options]
  pubmed-search get-by-pmid <pmid[,pmid...]> [options]
  pubmed-search mesh <term> [--rows N] [options]

Commands:
  search <query>          PubMed Boolean/MeSH/field-tagged search
                          -> {total, query, query_translation, warnings, results[]}
  get-by-pmid <pmid,...>  Fetch one or more articles by numeric PMID (comma-separated)
                          -> UnifiedResult, or {results[], missing[]} for multiple
  mesh <term>             MeSH descriptor lookup -> {term, results[]}

Search options:
  --rows N          Number of results (default 5, capped at maxRows)
  --offset N        Zero-based result offset for paging (NCBI retstart)
  --sort MODE       "relevance" (Best Match, default) or "date" (Most Recent)
  --ids-only        Only run esearch; return total + pmids[] (one request)
  --count-only      Only run esearch; return total + warnings (one request)
  --explain         Only run esearch; return query_translation + warnings

Get options:
  --format MODE     "json" (default) or "citation" (plain reference-list text)
  --no-cache        Bypass the local week-long PMID cache

Common options:
  --max-rows N      Override the maxRows cap (default 50)
  --email E         NCBI email (else PUBMED_EMAIL env var)
  --api-key K       NCBI API key, raises rate limit to 10 req/s (else NCBI_API_KEY)
  --no-email-check  Skip the "email not configured" guard (scripting only)
  --compact         Single-line JSON on stdout
  --json-errors     On failure, also print {"error": {...}} to stdout
  -h, --help        Show this help
  -v, --version     Show version

Output: JSON on stdout, errors on stderr. Exit: 0 ok, 1 runtime error, 2 usage error.
0 hits is a successful search: exit 0, total 0, results [] (see warnings/query_translation).`;
}

function flagString(flags: Record<string, string | boolean>, name: string): string | undefined {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
}

function reportUsageError(message: string): number {
  if (jsonErrors) {
    console.log(JSON.stringify({ error: { message }, exit_code: 2 }));
  } else {
    console.error(`error: ${message}\n\n${usage()}`);
  }
  return 2;
}

async function main(): Promise<number> {
  const { command, positional, flags } = parseArgs(process.argv.slice(2));
  jsonErrors = Boolean(flags["json-errors"]);

  if (flags.help) {
    console.log(usage());
    return 0;
  }
  if (flags.version) {
    console.log(`pubmed-search ${VERSION}`);
    return 0;
  }

  const email = flagString(flags, "email") ?? process.env.PUBMED_EMAIL;
  const apiKey = flagString(flags, "api-key") ?? process.env.NCBI_API_KEY;
  const requireEmail = flags["no-email-check"] ? false : true;

  const source = new PubMedSource({
    email,
    apiKey,
    requireEmail,
    maxRows: flagString(flags, "max-rows") !== undefined
      ? Number(flagString(flags, "max-rows"))
      : undefined,
  });
  const compact = Boolean(flags.compact);
  const print = (data: unknown): void => {
    console.log(compact ? JSON.stringify(data) : JSON.stringify(data, null, 2));
  };

  switch (command) {
    case "search": {
      const query = positional.join(" ");
      if (!query) {
        return reportUsageError("search requires a query string");
      }
      const rows = flagString(flags, "rows") !== undefined ? Number(flagString(flags, "rows")) : 5;
      if (!Number.isFinite(rows) || rows < 1) {
        return reportUsageError("--rows must be a positive integer");
      }
      const offset = flagString(flags, "offset") !== undefined
        ? Number(flagString(flags, "offset"))
        : 0;
      if (!Number.isInteger(offset) || offset < 0) {
        return reportUsageError("--offset must be a non-negative integer");
      }
      const sort = flagString(flags, "sort") ?? "relevance";
      if (sort !== "relevance" && sort !== "date") {
        return reportUsageError('--sort must be "relevance" or "date"');
      }
      print(await source.search(query, rows, sort, {
        offset,
        idsOnly: Boolean(flags["ids-only"]),
        countOnly: Boolean(flags["count-only"]),
        explain: Boolean(flags.explain),
      }));
      return 0;
    }
    case "get-by-pmid":
    case "get":
    case "by-pmid": {
      const raw = positional.join(",");
      if (!raw.trim()) {
        return reportUsageError("get-by-pmid requires one or more comma-separated PMIDs");
      }
      const pmids = raw.split(",").map((s) => s.trim()).filter((s) => s !== "");
      const format = flagString(flags, "format") ?? "json";
      if (format !== "json" && format !== "citation") {
        return reportUsageError('--format must be "json" or "citation"');
      }
      const noCache = Boolean(flags["no-cache"]);

      if (pmids.length === 1) {
        const result = await source.getByPmid(pmids[0], { noCache });
        if (format === "citation") console.log(formatCitation(result));
        else print(result);
        return 0;
      }

      const { results, missing } = await source.getByPmids(pmids, { noCache });
      if (format === "citation") {
        for (const result of results) console.log(formatCitation(result));
      } else {
        print(missing.length > 0 ? { results, missing } : { results });
      }
      return 0;
    }
    case "mesh":
    case "lookup-mesh":
    case "mesh-lookup": {
      const term = positional.join(" ");
      if (!term) {
        return reportUsageError("mesh requires a term");
      }
      const rows = flagString(flags, "rows") !== undefined ? Number(flagString(flags, "rows")) : 10;
      if (!Number.isFinite(rows) || rows < 1) {
        return reportUsageError("--rows must be a positive integer");
      }
      print(await source.lookupMesh(term, rows));
      return 0;
    }
    default:
      return reportUsageError(`unknown command "${command ?? ""}"`);
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    let message: string;
    let source: string | undefined;
    if (err instanceof DataSourceError) {
      message = err.message;
      source = err.source;
    } else if (err instanceof Error) {
      message = `error: ${err.message}`;
    } else {
      message = String(err);
    }

    if (jsonErrors) {
      console.log(JSON.stringify({ error: { source, message }, exit_code: 1 }));
    } else {
      console.error(message);
    }
    process.exitCode = 1;
  });
