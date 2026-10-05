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

echo "== --select contract =="
out="$("$CLI" candles BTCUSD --tf 1D --count 2 --select time_iso,close --format csv --cache "$CACHE" --timeout 30000 2>/dev/null)"
if [ "$(printf '%s\n' "$out" | head -1)" = "time_iso,close" ]; then
  echo "ok    select csv header narrows"
  pass=$((pass + 1))
else
  echo "FAIL  select csv header narrows (got: $(printf '%s\n' "$out" | head -1))"
  fail=$((fail + 1))
fi

out="$("$CLI" candles BTCUSD --tf 1D --count 2 --select time_iso,close --compact --cache "$CACHE" --timeout 30000 2>/dev/null)"
if printf '%s' "$out" | python3 -c 'import sys,json; d=json.load(sys.stdin); assert d["symbol"] and d["coverage"] and d["cache"]; assert set(d["candles"][0]) == {"time_iso","close"}'; then
  echo "ok    select keeps the json envelope"
  pass=$((pass + 1))
else
  echo "FAIL  select keeps the json envelope"
  fail=$((fail + 1))
fi

run_fail "unknown select field (strict)" candles BTCUSD --tf 1D --count 2 --select time_isoo --strict --cache "$CACHE"
run_fail "unknown flag (strict)" candles BTCUSD --tf 1D --count 2 --frobnicate --strict --cache "$CACHE"
run_fail "unsupported tf 360" candles BTCUSD --tf 360 --count 2 --cache "$CACHE"

echo "== resolution metadata =="
out="$("$CLI" candles SOL --tf 1D --count 1 --compact --cache "$CACHE" --timeout 30000 2>/dev/null)"
if printf '%s' "$out" | python3 -c 'import sys,json; d=json.load(sys.stdin); assert d["symbol"] == "BINANCE:SOLUSDT", d["symbol"]; assert d["unit"] == "price"'; then
  echo "ok    bare crypto ticker resolves to a price pair"
  pass=$((pass + 1))
else
  echo "FAIL  bare crypto ticker resolves to a price pair"
  fail=$((fail + 1))
fi

out="$("$CLI" candles CRYPTOCAP:USDT.D --tf 1D --count 1 --compact --cache "$CACHE" --timeout 30000 2>/dev/null)"
if printf '%s' "$out" | python3 -c 'import sys,json; d=json.load(sys.stdin); assert d["unit"] == "percent"; assert d["volume_reliable"] is False; assert d["candles"][0]["volume"] is None'; then
  echo "ok    index symbol reports percent / unreliable volume"
  pass=$((pass + 1))
else
  echo "FAIL  index symbol reports percent / unreliable volume"
  fail=$((fail + 1))
fi

echo "== indicators =="
run "indicators json" indicators BTCUSD --tf 1D --count 5 --cache "$CACHE" --timeout 60000
out="$("$CLI" indicators BTCUSD --tf 1D --count 5 --compact --cache "$CACHE" --timeout 60000 2>/dev/null)"
if printf '%s' "$out" | python3 -c 'import sys,json; d=json.load(sys.stdin); s=d["series"]; assert len(s) == 5; r=s[-1]; assert r["median_200"] is not None and r["macd"] is not None; assert r["kc1_upper"] > r["kc1_mid"] > r["kc1_lower"]'; then
  echo "ok    indicators compute through the warmup"
  pass=$((pass + 1))
else
  echo "FAIL  indicators compute through the warmup"
  fail=$((fail + 1))
fi
run_text "indicators csv" indicators BTCUSD --tf 1D --count 3 --select time_iso,macd --format csv --cache "$CACHE" --timeout 60000
run_fail "indicators needs a symbol" indicators

echo
echo "passed: $pass  failed: $fail"
[ "$fail" -eq 0 ]
