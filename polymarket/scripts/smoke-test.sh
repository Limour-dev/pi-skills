#!/usr/bin/env bash
# Smoke test for the polymarket CLI — hits the live public APIs.
# Read-only; safe to run repeatedly. Exits non-zero if any command fails.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$DIR/bin/polymarket"

# Stable, long-lived references used to keep the test deterministic.
MARKET_SLUG="xi-jinping-out-before-2027"
EVENT_ID="30828"
WALLET="0x2c649b504168c5414277f23135fb9ce36df72099"

pass=0
fail=0

run() {
  local desc="$1"; shift
  local out
  if ! out="$("$CLI" "$@" 2>&1)"; then
    echo "FAIL  $desc"
    echo "      $out" | head -3
    fail=$((fail + 1))
    return
  fi
  if ! printf '%s' "$out" | python3 -c "import sys,json; json.load(sys.stdin)" >/dev/null 2>&1; then
    echo "FAIL  $desc (output was not JSON)"
    echo "      $(printf '%s' "$out" | head -c 200)"
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
    echo "      $out" | head -3
    fail=$((fail + 1))
    return
  fi
  echo "ok    $desc"
  pass=$((pass + 1))
}

echo "== discovery =="
run "search"                  search fed --limit 1
run "events"                  events --limit 2
run "events --tag"            events --tag politics --limit 2
run "events --open --order"   events --open --order volume24hr --limit 2
run "events --fields"         events --limit 2 --fields id,title,volume24hr
run "events --brief"          events --limit 2 --brief
run "events --exclude-tag"    events --exclude-tag sports --limit 2
run "events --min-liquidity"  events --min-liquidity 1000 --limit 2
run_fail "events bad --order" events --order bogusfield --limit 2
run "event by slug"           event "$MARKET_SLUG"
run "event by id"             event "$EVENT_ID"
run "markets"                 markets --limit 2
run "markets --order"         markets --order volume24hr --limit 2
run "market by slug"          market "$MARKET_SLUG"
run "tags --search"           tags --search politics
run "tags --related"          tags --related politics --limit 2
run "comments"                comments "$MARKET_SLUG" --limit 1

echo "== pricing =="
run "price"                   price "$MARKET_SLUG"
run "price --outcome"         price "$MARKET_SLUG" --outcome No
run_fail "price extra arg"   price "$MARKET_SLUG" extra
run "book --depth"            book "$MARKET_SLUG" --depth 2
run "history"                 history "$MARKET_SLUG" --interval 1w
run "clock"                   clock

echo "== activity =="
run "trades"                  trades --limit 2
run "trades --market"         trades --market "$MARKET_SLUG" --limit 2
run "holders"                 holders "$MARKET_SLUG" --limit 1
run "positions"               positions "$WALLET" --limit 2
run "closed-positions"        closed-positions "$WALLET" --limit 2
run "activity"                activity "$WALLET" --limit 2
run "leaderboard"             leaderboard --limit 2
run "leaderboard --period"    leaderboard --period week --order vol --limit 2

echo "== resolution =="
run "resolve slug"            resolve "$MARKET_SLUG"
run "resolve URL"             resolve "https://polymarket.com/event/will-the-us-confirm-that-aliens-exist-before-2027"
run "resolve address"         resolve "0x56687bf447db6ffa42ffe2204a05edaa20f55839"

echo "== real time =="
# Avoid piping `watch` into `head`: the early close sends SIGPIPE, which
# pipefail would report as a failure even though the stream worked.
watch_out="$(mktemp)"
"$CLI" watch "$MARKET_SLUG" --duration 8 >"$watch_out" 2>&1 || true
if head -1 "$watch_out" | grep -q '"type":"connected"'; then
  echo "ok    watch"
  pass=$((pass + 1))
else
  echo "FAIL  watch"
  head -2 "$watch_out"
  fail=$((fail + 1))
fi
rm -f "$watch_out"

echo
echo "passed: $pass  failed: $fail"
[ "$fail" -eq 0 ]
