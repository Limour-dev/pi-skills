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


# N1: indicators rows carry OHLCV, so price and indicators come from one call.
out="$("$CLI" indicators BTCUSD --tf 1D --count 2 --select time_iso,close,kc1_lower --format csv --cache "$CACHE" --timeout 60000 2>/dev/null)"
if [ "$(printf '%s\n' "$out" | head -1)" = "time_iso,close,kc1_lower" ]; then
  echo "ok    indicators select includes price fields"
  pass=$((pass + 1))
else
  echo "FAIL  indicators select includes price fields (got: $(printf '%s\n' "$out" | head -1))"
  fail=$((fail + 1))
fi
out="$("$CLI" indicators BTCUSD --tf 1D --count 2 --select time_iso,close --compact --cache "$CACHE" --timeout 60000 2>/dev/null)"
if printf '%s' "$out" | python3 -c 'import sys,json; d=json.load(sys.stdin); r=d["series"][0]; assert "close" in r and "kc1_lower" not in r, r'; then
  echo "ok    indicators select narrows both price and indicator columns"
  pass=$((pass + 1))
else
  echo "FAIL  indicators select narrows both price and indicator columns"
  fail=$((fail + 1))
fi

# N2: a dropped --select field is visible in the JSON envelope, not only stderr.
out="$("$CLI" candles BTCUSD --tf 1D --count 2 --select time_iso,time_isoo --compact --cache "$CACHE" --timeout 30000 2>/dev/null)"
if printf '%s' "$out" | python3 -c 'import sys,json; d=json.load(sys.stdin); assert any("dropped" in w for w in d.get("warnings", [])), d.get("warnings"); assert "time_isoo" not in d["candles"][0]'; then
  echo "ok    dropped select field lands in envelope warnings"
  pass=$((pass + 1))
else
  echo "FAIL  dropped select field lands in envelope warnings"
  fail=$((fail + 1))
fi

# N2b: --quiet leaves stderr free of warning text.
err="$("$CLI" candles BTCUSD --tf 1D --count 2 --select time_iso,time_isoo --quiet --cache "$CACHE" --timeout 30000 2>&1 >/dev/null)"
if [ -z "$err" ]; then
  echo "ok    --quiet silences the select warning"
  pass=$((pass + 1))
else
  echo "FAIL  --quiet silences the select warning (stderr: $err)"
  fail=$((fail + 1))
fi
err="$("$CLI" candles BTCUSD --tf 1D --count 2 --frobnicate --quiet --cache "$CACHE" --timeout 30000 2>&1 >/dev/null)"
if [ -z "$err" ]; then
  echo "ok    --quiet silences the unknown-flag warning"
  pass=$((pass + 1))
else
  echo "FAIL  --quiet silences the unknown-flag warning (stderr: $err)"
  fail=$((fail + 1))
fi

# N3: the warning points across commands and suggests the nearest field.
err="$("$CLI" candles BTCUSD --tf 1D --count 2 --select time_isoo --strict --cache "$CACHE" --timeout 30000 2>&1 >/dev/null)"
case "$err" in
  *'did you mean'*time_iso*) echo "ok    typo gets a did-you-mean hint"; pass=$((pass + 1)) ;;
  *) echo "FAIL  typo gets a did-you-mean hint (stderr: $err)"; fail=$((fail + 1)) ;;
esac
err="$("$CLI" candles BTCUSD --tf 1D --count 2 --select kc1_mid --strict --cache "$CACHE" --timeout 30000 2>&1 >/dev/null)"
case "$err" in
  *'live in `indicators`'*) echo "ok    cross-command hint points at indicators"; pass=$((pass + 1)) ;;
  *) echo "FAIL  cross-command hint points at indicators (stderr: $err)"; fail=$((fail + 1)) ;;
esac

# N5: an unsupported --tf is a local USAGE error (exit 2), not a server SERIES_ERROR.
"$CLI" candles BTCUSD --tf 360 --count 1 --cache "$CACHE" >/dev/null 2>&1
code=$?
if [ "$code" -eq 2 ]; then
  echo "ok    unsupported --tf exits 2 (USAGE)"
  pass=$((pass + 1))
else
  echo "FAIL  unsupported --tf exits 2 (got $code)"
  fail=$((fail + 1))
fi
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
