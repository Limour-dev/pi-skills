#!/usr/bin/env bash
# Smoke test for the tradingview CLI — hits live TradingView endpoints.
# Read-only; safe to run repeatedly. Exits non-zero if any check fails.
#
#   npm run smoke
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$DIR/bin/tradingview"

pass=0
fail=0

run() {
  local desc="$1"; shift
  local out
  if ! out="$("$CLI" "$@" 2>&1)"; then
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

run_any() {
  local desc="$1"; shift
  local out
  if ! out="$("$CLI" "$@" 2>&1)"; then
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

run_fail() {
  local desc="$1"; shift
  local out
  if out="$("$CLI" "$@" 2>&1)"; then
    echo "FAIL  $desc (expected non-zero exit)"
    printf '      %s\n' "$out" | head -3
    fail=$((fail + 1))
    return
  fi
  echo "ok    $desc"
  pass=$((pass + 1))
}

echo "== setup / introspection =="
run "version"                 version
run "aliases"                 aliases --format json
run "resolve alias"           resolve USDT.D --quiet
run "resolve continuous"      resolve CNH1! --quiet
run "resolve verify"          resolve CNH1! --verify --quiet

echo "== quotes (the headline use case) =="
run "quote four symbols"      quote USDT.D US10Y CNH1! BTCUSD --timeout 30000
run "quote explicit exchange" quote BINANCE:BTCUSDT TVC:DXY --timeout 30000
run_any "quote table"           quote BTCUSD --format table
run "quote select"            quote BTCUSD --select input,symbol,last --timeout 30000
run_fail "quote unknown"      quote ZZ_NOPE_NOT_A_SYMBOL

echo "== candles =="
run "candles daily"           candles BTCUSD --tf 1D --count 5 --timeout 30000
run "candles derived"         candles CRYPTOCAP:USDT.D --tf 240 --count 5 --timeout 30000
run "candles from range"      candles TVC:US10Y --tf W --from -30d --timeout 30000

echo "== symbol metadata =="
run "search"                  search "offshore yuan" --limit 3
run "info"                    info CNH1! --timeout 30000

echo "== scanner =="
run "ta"                      ta BTCUSD
run "screener"                screener --market crypto --columns name,close,change,volume --sort volume:desc --limit 3
run "hotlist"                 hotlist --kind gainers --market crypto --limit 3
run_fail "screener bad filter op" screener --columns name,close --filter '[{"left":"close","operation":"bogusop","right":1}]' --limit 1

echo "== indicator (built-in, anonymous) =="
run "indicator volume"        indicator BTCUSD --indicator Volume@tv-basicstudies-241 --tf 1D --last 2 --timeout 30000

echo "== live watch =="
run_any "watch quote"           watch BTCUSD --duration 6 --changes-only --timeout 30000

echo
echo "passed: $pass  failed: $fail"
[ "$fail" -eq 0 ]
