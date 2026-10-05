/**
 * Offline mock of the handful of Massive endpoints this skill uses.
 *
 * Lets the test suite (and `scripts/smoke-test.sh`) exercise pagination,
 * normalisation, GEX/max-pain maths and error handling end to end without an
 * API key or network access:
 *
 *   node tests/mock-server.ts --port 8799
 *   massive-options gex TEST --base-url http://127.0.0.1:8799 --api-key test
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

export interface MockServer {
  url: string;
  port: number;
  requests: number;
  close: () => Promise<void>;
}

interface MockOptions {
  /** Rows per snapshot page; forces `next_url` pagination. */
  pageSize?: number;
  fixture?: string;
}

type Row = Record<string, any>;

function loadFixture(name = "snapshot-test.json"): Row[] {
  const text = readFileSync(join(HERE, "fixtures", name), "utf8");
  return (JSON.parse(text) as { results: Row[] }).results;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

function notAuthorized(res: ServerResponse): void {
  json(res, 403, {
    status: "NOT_AUTHORIZED",
    message: "You are not entitled to this data. Please upgrade your plan at https://massive.com/pricing",
    request_id: "mock-not-authorized",
  });
}

const SPOT = 100;

export async function startMockServer(opts: MockOptions = {}): Promise<MockServer> {
  const rows = loadFixture(opts.fixture);
  const pageSize = opts.pageSize ?? 4;
  const state = { requests: 0 };

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    state.requests++;
    const host = req.headers.host ?? "127.0.0.1";
    const url = new URL(req.url ?? "/", `http://${host}`);
    const path = decodeURIComponent(url.pathname);
    const q = url.searchParams;

    if (path.startsWith("/v3/snapshot/options/")) {
      const underlying = decodeURIComponent(path.split("/").pop() ?? "");
      // Mirrors the real API: only "TEST" is entitled to the chain snapshot.
      if (underlying !== "TEST") return notAuthorized(res);
      const gte = q.get("expiration_date.gte");
      const lte = q.get("expiration_date.lte");
      let matching = rows.filter((r) => {
        const e: string = r.details?.expiration_date ?? "";
        if (gte && e < gte) return false;
        if (lte && e > lte) return false;
        return true;
      });
      const offset = Number(q.get("cursor") ?? 0) || 0;
      const page = matching.slice(offset, offset + pageSize);
      const nextOffset = offset + pageSize;
      const next_url =
        nextOffset < matching.length
          ? `${url.origin}${path}?${q.toString().replace(/(^|&)cursor=[^&]*/g, "$1")}&cursor=${nextOffset}`
          : undefined;
      json(res, 200, {
        status: "OK",
        request_id: `mock-${state.requests}`,
        next_url,
        results: page.map((r) => ({ ...r, underlying_asset: { ...r.underlying_asset, ticker: underlying } })),
      });
      return;
    }

    if (path === "/v3/reference/options/contracts") {
      const gte = q.get("expiration_date.gte");
      const lte = q.get("expiration_date.lte");
      const underlying = q.get("underlying_ticker") ?? "TEST";
      const seen = new Map<string, Row>();
      for (const r of rows) {
        const e: string = r.details?.expiration_date ?? "";
        if (gte && e < gte) continue;
        if (lte && e > lte) continue;
        if (seen.has(e)) continue;
        seen.set(e, {
          cfi: "OCASPS",
          contract_type: "call",
          exercise_style: "american",
          expiration_date: e,
          primary_exchange: "BATO",
          shares_per_contract: 100,
          strike_price: r.details?.strike_price,
          ticker: r.details?.ticker,
          underlying_ticker: underlying,
        });
      }
      json(res, 200, { status: "OK", results: [...seen.values()].sort((a, b) => String(a.expiration_date).localeCompare(String(b.expiration_date))) });
      return;
    }

    if (/^\/v3\/reference\/options\/contracts\/O:/.test(path)) {
      const ticker = decodeURIComponent(path.split("/").pop() ?? "");
      const row = rows.find((r) => r.details?.ticker === ticker);
      if (!row) {
        json(res, 404, { status: "NOT_FOUND", message: "contract not found" });
        return;
      }
      json(res, 200, { status: "OK", results: { ...row.details, cfi: "OCASPS", underlying_ticker: "TEST" } });
      return;
    }

    if (/^\/v2\/aggs\/ticker\/[^/]+\/prev$/.test(path)) {
      json(res, 200, {
        status: "DELAYED",
        ticker: decodeURIComponent(path.split("/")[4] ?? ""),
        resultsCount: 1,
        results: [{ T: "TEST", c: SPOT, o: SPOT - 1, h: SPOT + 1, l: SPOT - 2, v: 1_000_000, t: 1790952000000 }],
      });
      return;
    }

    if (path.startsWith("/v2/snapshot/locale/us/markets/stocks/tickers/")) {
      return notAuthorized(res);
    }

    if (path === "/v1/marketstatus/now") {
      json(res, 200, { market: "open", serverTime: "2026-10-02T12:00:00-04:00" });
      return;
    }

    json(res, 404, { status: "NOT_FOUND", message: `no mock route for ${path}` });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    get requests() {
      return state.requests;
    },
    close: () =>
      new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  const portArg = process.argv.indexOf("--port");
  const server = await startMockServer();
  console.log(`mock Massive API on ${server.url} (fixture: snapshot-test.json)`);
  if (portArg !== -1) console.log(`requested --port ${process.argv[portArg + 1]} ignored; using ${server.port}`);
}
