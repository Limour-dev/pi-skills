#!/usr/bin/env bash
# Live smoke test for the optioncharts CLI — exercises every command against
# optioncharts.io exactly as an agent would.
#
#   bash scripts/smoke-test.sh          # full pass (TLT + SPY + QQQ)
#   bash scripts/smoke-test.sh --quick  # TLT only, fewer expiries
#
# Needs network access to optioncharts.io (~2 s per fragment). The offline
# checks at the end never touch the network.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$DIR/bin/optioncharts"
FIX="$DIR/tests/fixtures"
QUICK=0
[ "${1:-}" = "--quick" ] && QUICK=1

PASS=0
FAIL=0

check() {
  local desc="$1" needle="$2" output="$3"
  if printf '%s' "$output" | grep -q -- "$needle"; then
    echo "PASS: $desc"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $desc (expected \"$needle\")"
    printf '%s\n' "$output" | head -10
    FAIL=$((FAIL + 1))
  fi
}

check_code() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "PASS: $desc"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $desc (expected exit $expected, got $actual)"
    FAIL=$((FAIL + 1))
  fi
}

run() {
  # Run the CLI, tolerating non-zero exits so we can assert on them.
  set +e
  "$CLI" "$@" 2>&1
  set -e
}

code() {
  set +e
  "$CLI" "$@" >/dev/null 2>&1
  local status=$?
  set -e
  echo "$status"
}

echo "== probe =="
OUT=$(run probe)
check "probe reports an overall status" '"ok"' "$OUT"
check "probe lists the statistics endpoint" 'chain_statistics' "$OUT"

echo "== spot / info =="
OUT=$(run spot TLT --format compact)
check "spot has a price" '"price"' "$OUT"
check "spot names the delay" '15 minutes delayed' "$OUT"
OUT=$(run info TLT --format compact)
check "info has dividend yield" '"dividend_yield_pct"' "$OUT"

echo "== expiries =="
OUT=$(run expiries TLT --dte 14 --format compact)
check "expiries carries the :w/:m suffix" '"exp":"20' "$OUT"
check "expiries has day counts" '"dte":' "$OUT"
EXP=$(printf '%s' "$OUT" | grep -o '[0-9]\{4\}-[0-9]\{2\}-[0-9]\{2\}:[wm]' | head -1)
echo "     using expiry $EXP"

echo "== stats (weekly scan core) =="
OUT=$(run stats TLT SPY QQQ --dte 7 --format csv)
check "stats csv has a header" 'ticker,expiration,volume_total' "$OUT"
check "stats covers TLT" 'TLT,' "$OUT"
check "stats covers SPY" 'SPY,' "$OUT"
check "stats covers QQQ" 'QQQ,' "$OUT"

echo "== gex / dex =="
OUT=$(run gex TLT --exp "$EXP" --top 5 --format compact)
check "gex reports the exposure unit" '"unit":"usd_per_1pct_move"' "$OUT"
check "gex has a call wall" '"call_wall"' "$OUT"
check "gex has per-strike rows" '"gex_by_strike"' "$OUT"
OUT=$(run dex TLT --exp "$EXP" --top 3 --format compact --allow-exp-fallback)
check "dex reports DEX" '"exposure":"DEX"' "$OUT"

echo "== oi / volume / skew / greeks =="
OUT=$(run oi TLT --exp "$EXP" --top 3 --format compact --allow-exp-fallback)
check "oi has open interest" '"open_interest"' "$OUT"
OUT=$(run volume TLT --exp "$EXP" --top 3 --format compact --allow-exp-fallback)
check "volume has volume" '"volume"' "$OUT"
OUT=$(run skew TLT --exp "$EXP" --top 3 --format compact --allow-exp-fallback)
check "skew has iv_pct" '"iv_pct"' "$OUT"
OUT=$(run greeks TLT --exp "$EXP" --top 4 --format compact --allow-exp-fallback)
check "greeks lists available greeks" '"available_greeks"' "$OUT"

echo "== max-pain / em / chain =="
OUT=$(run max-pain TLT --format compact)
check "max-pain has rows" '"max_pain"' "$OUT"
OUT=$(run em TLT --limit 3 --format csv)
check "expected-move cone has points" 'em_amt' "$OUT"
OUT=$(run chain TLT --exp "$EXP" --top 3 --format csv --allow-exp-fallback)
check "chain has a call row" 'CALL' "$OUT"
check "chain has a put row" 'PUT' "$OUT"

echo "== weekly scan =="
if [ "$QUICK" = "1" ]; then
  OUT=$(run scan TLT --dte 7 --weekly-only --format csv)
else
  OUT=$(run scan TLT SPY QQQ --dte 7 --weekly-only --gex --concurrency 2 --format csv)
fi
check "scan emits the weekly table" 'ticker,expiration,kind,dte' "$OUT"
check "scan flags expiry fallbacks" 'expiry_fallback' "$OUT"
if [ "$QUICK" = "0" ]; then
  check "scan reports walls with --gex" ',7[0-9][0-9],' "$OUT"
fi

echo "== raw =="
OUT=$(run raw TLT --endpoint gamma_exposure --exp "$EXP" --format compact --allow-exp-fallback)
check "raw lists inline variables" '"inline_variables"' "$OUT"
check "raw extracts the exposure JSON" '"chart_exposure_data"' "$OUT"

echo "== exit codes (offline fixtures) =="
check_code "invalid ticker exits 3" 3 "$(code stats ZZZZZZ --from-file "$FIX/invalid-ticker.html")"
check_code "usage error exits 2" 2 "$(code gex TLT --nope)"
check_code "silent expiry fallback exits 5" 5 "$(code gex TLT --exp 2026-10-09:w --from-file "$FIX/tlt-gamma-exposure-fallback.html")"
check_code "expiry fallback allowed exits 0" 0 "$(code gex TLT --exp 2026-10-09:w --allow-exp-fallback --from-file "$FIX/tlt-gamma-exposure-fallback.html")"
check_code "offline stats exits 0" 0 "$(code stats TLT --from-file "$FIX/tlt-stats.html")"

echo "== cone / normalisation / units (offline fixtures) =="
OUT=$(run em TLT --limit 2 --format csv --from-file "$FIX/tlt-expected-move.html")
check "em csv leads with et_date" 'ticker,et_date,et_time' "$OUT"
check "em cone row carries the ET session date" 'TLT,2026-10-05,23:59:59' "$OUT"
OUT=$(run gex TLT --exp 2026-10-09:w --format compact --from-file "$FIX/tlt-gamma-exposure.html")
check "gex always exposes share_of_abs_total_pct" '"share_of_abs_total_pct"' "$OUT"
check "gex exposes the exposure snapshot time" '"exposure_as_of"' "$OUT"
OUT=$(run gex TLT --exp 2026-10-09:w --format csv --units --from-file "$FIX/tlt-gamma-exposure.html")
check "--units annotates the net_exposure column" 'net_exposure\[usd_per_1pct_move\]' "$OUT"

echo
echo "passed: $PASS  failed: $FAIL"
[ "$FAIL" -eq 0 ]
