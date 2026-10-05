#!/usr/bin/env bash
# Smoke test for massive-options.
#
#   scripts/smoke-test.sh          # offline: unit + CLI tests against the mock API
#   scripts/smoke-test.sh --live   # also probe the real API with MASSIVE_API_KEY
#
# Offline mode is deterministic and needs no credentials. Live mode is read-only
# and treats "not entitled" as SKIP, since the chain snapshot needs a paid plan.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$DIR/cli.ts"
LIVE=0
[[ "${1:-}" == "--live" ]] && LIVE=1

pass=0
fail=0
skip=0

ok()   { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass + 1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail + 1)); }
skipped() { printf '  \033[33mSKIP\033[0m %s\n' "$1"; skip=$((skip + 1)); }

echo "== offline: unit + CLI tests (mock API)"
if node --test "$DIR/tests/"*.test.ts >/tmp/massive-options-tests.log 2>&1; then
  ok "node --test tests/*.test.ts ($(grep -c '^✔' /tmp/massive-options-tests.log) cases)"
else
  bad "node --test tests/*.test.ts — see /tmp/massive-options-tests.log"
  tail -30 /tmp/massive-options-tests.log
fi

echo "== offline: --from-file end to end"
gex=$(node "$CLI" gex TEST --from-file "$DIR/tests/fixtures/snapshot-test.json" --dte 7 --as-of 2026-10-02 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).total.gex)}catch{console.log("parse-error")}})')
[[ "$gex" == "14000" ]] && ok "gex --from-file total = 14000" || bad "gex --from-file total = $gex (expected 14000)"

pain=$(node "$CLI" max-pain TEST --from-file "$DIR/tests/fixtures/snapshot-test.json" --dte 7 --as-of 2026-10-02 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).total.maxPain)}catch{console.log("parse-error")}})')
[[ "$pain" == "100" ]] && ok "max-pain --from-file strike = 100" || bad "max-pain --from-file strike = $pain (expected 100)"

echo "== offline: credential hygiene"
out=$(node "$CLI" gex TEST --from-file "$DIR/tests/fixtures/snapshot-test.json" --dte 7 --as-of 2026-10-02 2>&1)
[[ "$out" != *"apiKey="* ]] && ok "apiKey never echoed" || bad "apiKey leaked in output"

if [[ "$LIVE" == "0" ]]; then
  echo
  echo "offline suite: $pass passed, $fail failed, $skip skipped"
  echo "re-run with --live to hit the real API (needs MASSIVE_API_KEY)"
  [[ "$fail" -eq 0 ]] || exit 1
  exit 0
fi

echo "== live: read-only API checks"
if [[ -z "${MASSIVE_API_KEY:-}" ]]; then
  skipped "MASSIVE_API_KEY not set"
else
  if node "$CLI" expiries SPY --dte 7 >/tmp/mo-expiries.json 2>/tmp/mo-expiries.err; then
    n=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("/tmp/mo-expiries.json","utf8")).expirations.length)')
    ok "expiries SPY --dte 7 ($n expirations)"
  else
    bad "expiries SPY — $(head -1 /tmp/mo-expiries.err)"
  fi
  sleep 13

  if node "$CLI" spot SPY >/tmp/mo-spot.json 2>/tmp/mo-spot.err; then
    p=$(node -e 'const j=JSON.parse(require("fs").readFileSync("/tmp/mo-spot.json","utf8"));console.log(j.price+"/"+j.source)')
    ok "spot SPY ($p)"
  else
    bad "spot SPY — $(head -1 /tmp/mo-spot.err)"
  fi
  sleep 13

  node "$CLI" gex SPY --dte 7 >/tmp/mo-gex.json 2>/tmp/mo-gex.err
  code=$?
  if [[ "$code" == "0" ]]; then
    ok "gex SPY --dte 7 (plan includes the chain snapshot)"
  elif [[ "$code" == "3" ]] && grep -q "chain snapshot" /tmp/mo-gex.err; then
    skipped "gex SPY --dte 7: $(tail -1 /tmp/mo-gex.err)"
  else
    bad "gex SPY --dte 7 (exit $code) — $(head -1 /tmp/mo-gex.err)"
  fi
fi

echo
echo "total: $pass passed, $fail failed, $skip skipped"
[[ "$fail" -eq 0 ]] || exit 1
