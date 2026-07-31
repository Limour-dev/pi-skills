#!/usr/bin/env node
/**
 * Command-line interface for the pure-TypeScript PubMed client.
 *
 * The ONLY supported way to use this skill is through this CLI, invoked via
 * bash — agents should never import src/pubmed.ts directly.
 *
 * Examples:
 *   node cli.ts search "glioblastoma[Title] AND MRI[Title]" --rows 5 --sort relevance
 *   node cli.ts get-by-pmid 28344011
 *   node cli.ts mesh "Alzheimer Disease"
 *   PUBMED_EMAIL=you@example.com NCBI_API_KEY=... node cli.ts search "heart failure"
 *
 * Output contract:
 *   - success: result JSON on stdout (pretty-printed; add --compact for one line)
 *   - failure: human-readable error on stderr
 *   - exit codes: 0 = ok, 1 = runtime/data error, 2 = usage error
 */
import { PubMedSource, DataSourceError } from "./src/pubmed.ts";

const VERSION = "1.0.0";

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
  pubmed-search search <query> [--rows N] [--sort relevance|date] [--max-rows N] [--email E] [--api-key K] [--compact]
  pubmed-search get-by-pmid <pmid> [--email E] [--api-key K] [--compact]
  pubmed-search mesh <term> [--email E] [--api-key K] [--compact]

Commands:
  search <query>       PubMed Boolean/MeSH/field-tagged search -> {total, query, results[]}
  get-by-pmid <pmid>   Fetch one article by numeric PMID -> UnifiedResult
  mesh <term>          MeSH descriptor lookup -> {term, results[]}

Options:
  --rows N          Number of results (default 5, capped at maxRows)
  --sort MODE       "relevance" (Best Match, default) or "date" (Most Recent)
  --max-rows N      Override the maxRows cap (default 50)
  --email E         NCBI email (else PUBMED_EMAIL env var)
  --api-key K       NCBI API key, raises rate limit to 10 req/s (else NCBI_API_KEY)
  --no-email-check  Skip the "email not configured" guard (scripting only)
  --compact         Single-line JSON on stdout
  -h, --help        Show this help
  -v, --version     Show version

Output: JSON on stdout, errors on stderr. Exit: 0 ok, 1 runtime error, 2 usage error.`;
}

function flagString(flags: Record<string, string | boolean>, name: string): string | undefined {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
}

async function main(): Promise<number> {
  const { command, positional, flags } = parseArgs(process.argv.slice(2));

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
        console.error(`error: search requires a query string\n\n${usage()}`);
        return 2;
      }
      const rows = flagString(flags, "rows") !== undefined ? Number(flagString(flags, "rows")) : 5;
      if (!Number.isFinite(rows) || rows < 1) {
        console.error("error: --rows must be a positive integer");
        return 2;
      }
      const sort = flagString(flags, "sort") ?? "relevance";
      if (sort !== "relevance" && sort !== "date") {
        console.error('error: --sort must be "relevance" or "date"');
        return 2;
      }
      print(await source.search(query, rows, sort));
      return 0;
    }
    case "get-by-pmid":
    case "get":
    case "by-pmid": {
      const pmid = positional[0];
      if (!pmid) {
        console.error(`error: get-by-pmid requires a PMID\n\n${usage()}`);
        return 2;
      }
      print(await source.getByPmid(pmid));
      return 0;
    }
    case "mesh":
    case "lookup-mesh":
    case "mesh-lookup": {
      const term = positional.join(" ");
      if (!term) {
        console.error(`error: mesh requires a term\n\n${usage()}`);
        return 2;
      }
      print(await source.lookupMesh(term));
      return 0;
    }
    default:
      console.error(`error: unknown command "${command ?? ""}"\n\n${usage()}`);
      return 2;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    if (err instanceof DataSourceError) {
      console.error(err.message);
    } else if (err instanceof Error) {
      console.error(`error: ${err.message}`);
    } else {
      console.error(`error: ${String(err)}`);
    }
    process.exitCode = 1;
  });
