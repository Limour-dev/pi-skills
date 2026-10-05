#!/usr/bin/env bash
# Live smoke test for the options-gex CLI — exercises every command against the
# real Sell The News endpoints, exactly as an agent would.
#
#   bash scripts/smoke-test.sh        # or: npm run smoke
#
# Needs network access to sellthenews.org and mcp.sellthenews.org. The offline
# checks at the end never touch the network.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$DIR/bin/options-gex"
PASS=0
FAIL=0

check() {
  local desc="$1" needle="$2" output="$3"
  if printf '%s' "$output" | grep -q -- "$needle"; then
    echo "PASS: $desc"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $desc (expected \"$needle\")"
    printf '%s\n' "$output" | head -20
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

echo "== probe =="
OUT=$("$CLI" probe)
check "probe reports overall ok" '"ok": true' "$OUT"
check "probe reports the REST channel" '"rest"' "$OUT"
check "probe reports the MCP channel" '"mcp"' "$OUT"

echo "== levels =="
OUT=$("$CLI" levels SPY --format compact)
check "levels has a selected expiry" '"selected_exp"' "$OUT"
check "levels has a spot" '"spot"' "$OUT"
check "levels has net_gex" '"net_gex"' "$OUT"

echo "== walls =="
OUT=$("$CLI" walls SPY --format compact)
check "walls has call_wall" '"call_wall"' "$OUT"
check "walls has put_wall" '"put_wall"' "$OUT"
check "walls reports spot distance" '"spot_side"' "$OUT"

echo "== max-pain =="
OUT=$("$CLI" max-pain SPY --format compact)
check "max-pain has max_pain" '"max_pain"' "$OUT"

echo "== flip =="
OUT=$("$CLI" flip SPY --format compact)
check "flip has gamma_flip" '"gamma_flip"' "$OUT"
check "flip has a regime" '"regime"' "$OUT"

echo "== gex =="
OUT=$("$CLI" gex SPY --top 5 --format compact)
check "gex uses dollar units on REST" '"units":"usd_gex"' "$OUT"
check "gex returns rows" '"gex_by_strike"' "$OUT"
check "gex rows carry pretty values" '"value_pretty"' "$OUT"

echo "== skew =="
OUT=$("$CLI" skew SPY --top 3 --format compact)
check "skew has vanna" '"vanna"' "$OUT"
check "skew has charm" '"charm"' "$OUT"
check "skew rows are exposure units (no dollar sign)" '"unit":"exposure"' "$OUT"

echo "== expiries =="
OUT=$("$CLI" expiries SPY --dte 7 --format compact)
check "expiries has a count" '"count"' "$OUT"
check "expiries lists dates" '"exp"' "$OUT"

echo "== raw =="
OUT=$("$CLI" raw SPY --top 3 --format compact)
check "raw has cumulative GEX" '"cum_gex"' "$OUT"
check "raw has insights" '"insights"' "$OUT"


echo "== scan =="
OUT=$("$CLI" scan SPY --dte 7 --max-exp 3 --concurrency 2 --format compact)
check "scan lists tickers" '"tickers"' "$OUT"
check "scan returns rows" '"scan"' "$OUT"
check "scan carries payload_fetched_at" '"payload_fetched_at"' "$OUT"

echo "== MCP fallback =="
OUT=$("$CLI" walls SPY --source mcp --max-strikes 5 --format compact)
check "mcp source is reported" '"source":"mcp"' "$OUT"
check "mcp warns about rounding" 'rounded/scaled' "$OUT"

echo "== offline fixtures =="
FIX="$DIR/tests/fixtures"
OUT=$("$CLI" gex SPY --from-file "$FIX/spy-2026-10-05-gamma.json" --top 3 --format compact)
check "fixture net_gex scales to \$544.93M" '"net_gex_usd":"\$544.93M"' "$OUT"

set +e
"$CLI" levels SPY --exp 2019-01-18 --from-file "$FIX/rest-fallback.json" --strict-exp >/dev/null 2>&1
CODE=$?
set -e
check_code "strict-exp fallback exits 5" 5 "$CODE"

set +e
"$CLI" gex ZZZZZZ --no-cache >/dev/null 2>&1
CODE=$?
set -e
check_code "unknown ticker exits 3" 3 "$CODE"

set +e
"$CLI" gex SPY --nope >/dev/null 2>&1
CODE=$?
set -e
check_code "unknown flag exits 2" 2 "$CODE"

echo
echo "passed: $PASS  failed: $FAIL"
[ "$FAIL" -eq 0 ]
