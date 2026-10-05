#!/usr/bin/env bash
# Smoke test for the tradingview candle CLI — hits live TradingView endpoints.
# Read-only; safe to run repeatedly. Exits non-zero if any check fails.
#
#   npm run smoke
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$DIR/bin/tradingview"
CACHE="${TMPDIR:-/tmp}/tradingview-smoke-$$.sqlite"

pass=0
fail=0

cleanup() { rm -f "$CACHE" "$CACHE"-wal "$CACHE"-shm; }
trap cleanup EXIT

run() {
  local desc="$1"; shift
  local out
  if ! out="$("$CLI" "$@" 2>/dev/null)"; then
    echo "FAIL  $desc"
    printf '      %s\n' "$out" | head -3
    fail=$((fail + 1))
    return
  fi
  if ! printf '%s' "$out" | python3 -c "import sys,json; json.load(sys.stdin)" >/dev/null 2>&1; then
    echo "FAIL  $desc (output was not JSON)"
    printf '      %s\n' "$(printf '%s' "$out" | head -c 200)"
    fail=$((fail + 1))
    return
  fi
  echo "ok    $desc"
  pass=$((pass + 1))
}

run_fail() {
  local desc="$1"; shift
  if "$CLI" "$@" >/dev/null 2>&1; then
    echo "FAIL  $desc (expected non-zero exit)"
    fail=$((fail + 1))
    return
  fi
  echo "ok    $desc"
  pass=$((pass + 1))
}

run_text() {
  local desc="$1"; shift
  local out
  if ! out="$("$CLI" "$@" 2>/dev/null)"; then
    echo "FAIL  $desc"
    printf '      %s\n' "$out" | head -3
    fail=$((fail + 1))
    return
  fi
  if [ -z "$out" ]; then
    echo "FAIL  $desc (no output)"
    fail=$((fail + 1))
    return
  fi
  echo "ok    $desc"
  pass=$((pass + 1))
}

echo "== introspection =="
run "version"            version

echo "== candles =="
run "daily alias"        candles BTCUSD --tf 1D --count 5 --cache "$CACHE" --timeout 30000
run "cache hit"          candles BTCUSD --tf 1D --count 5 --cache "$CACHE" --timeout 30000
run "wider count"        candles BTCUSD --tf 1D --count 20 --cache "$CACHE" --timeout 30000
run "crypto dominance"   candles CRYPTOCAP:USDT.D --tf 240 --count 5 --cache "$CACHE" --timeout 30000
run "from range"         candles TVC:US10Y --tf W --from -30d --cache "$CACHE" --timeout 30000
run "monthly"            candles BINANCE:BTCUSDT --tf M --count 4 --cache "$CACHE" --timeout 30000
run "no cache"           candles BTCUSD --tf 1D --count 3 --no-cache --timeout 30000
run_text "csv output"      candles BTCUSD --tf 1D --count 2 --no-cache --format csv --timeout 30000

echo "== errors =="
run_fail "bad timeframe" candles BTCUSD --tf 7h
run_fail "empty range"   candles BTCUSD --from 2030-01-01
run_fail "unknown command" quote BTCUSD

echo
echo "passed: $pass  failed: $fail"
[ "$fail" -eq 0 ]
