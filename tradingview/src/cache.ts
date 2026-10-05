/**
 * SQLite candle cache.
 *
 * Uses Node's built-in `node:sqlite` (no native dependency, no install step).
 * Rows are keyed by `(symbol, timeframe, variant, time)` so a bar is stored at
 * most once and re-writing it only refreshes the OHLCV values.
 *
 * `variant` encodes every chart option that changes the numbers (bar type,
 * currency conversion, price adjustment, trading session), so two differently
 * configured requests never share rows.
 *
 * The database lives outside the repo by default (XDG cache dir). Override the
 * location with `TV_CACHE_DB` or `--cache <path>`; disable it with `--no-cache`.
 */

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Candle } from "@mathieuc/tradingview/data";

export type CacheKey = {
  symbol: string;
  timeframe: string;
  variant: string;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS candles (
  symbol    TEXT    NOT NULL,
  timeframe TEXT    NOT NULL,
  variant   TEXT    NOT NULL,
  time      INTEGER NOT NULL,
  open      REAL    NOT NULL,
  high      REAL    NOT NULL,
  low       REAL    NOT NULL,
  close     REAL    NOT NULL,
  volume    REAL    NOT NULL,
  PRIMARY KEY (symbol, timeframe, variant, time)
) WITHOUT ROWID;
`;

export type Cache = DatabaseSync;

export function defaultCachePath(): string {
  const explicit = process.env.TV_CACHE_DB;
  if (explicit) return explicit;
  const base = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(base, "tradingview", "candles.sqlite");
}

/** Open (creating if needed) the cache database. */
export function openCache(file: string = defaultCachePath()): Cache {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  // WAL lets several CLI processes read/write concurrently; busy_timeout makes
  // a writer wait instead of failing while another process holds the lock.
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  return db;
}

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Bars of `key` with `from <= time <= to`, oldest first. */
export function readCandles(db: Cache, key: CacheKey, from: number, to: number): Candle[] {
  const rows = db
    .prepare(
      `SELECT time, open, high, low, close, volume
         FROM candles
        WHERE symbol = ? AND timeframe = ? AND variant = ? AND time >= ? AND time <= ?
        ORDER BY time ASC`,
    )
    .all(key.symbol, key.timeframe, key.variant, from, to) as unknown as Array<Record<string, number>>;
  return rows.map((row) => ({
    time: row.time,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,
  }));
}

/** Insert or refresh `candles`; returns the number of rows written. */
export function writeCandles(db: Cache, key: CacheKey, candles: readonly Candle[]): number {
  if (candles.length === 0) return 0;
  const stmt = db.prepare(
    `INSERT INTO candles (symbol, timeframe, variant, time, open, high, low, close, volume)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(symbol, timeframe, variant, time) DO UPDATE SET
       open = excluded.open,
       high = excluded.high,
       low = excluded.low,
       close = excluded.close,
       volume = excluded.volume`,
  );
  db.exec("BEGIN");
  try {
    for (const c of candles) {
      stmt.run(
        key.symbol,
        key.timeframe,
        key.variant,
        Math.trunc(c.time),
        finite(c.open),
        finite(c.high),
        finite(c.low),
        finite(c.close),
        finite(c.volume),
      );
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return candles.length;
}

