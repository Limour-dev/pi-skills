#!/usr/bin/env bash
# Smoke test for the pubmed-search CLI — exercises all commands against the
# live NCBI API via bash, exactly as an agent would.
#
#   bash scripts/smoke-test.sh        # or: npm run smoke
#
# Requires network access to eutils.ncbi.nlm.nih.gov. Uses --no-email-check
# so it runs without configuration; export PUBMED_EMAIL to be polite to NCBI.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$DIR/bin/pubmed-search"
# Isolate the throttle lock / PMID cache from the user's real cache.
export PUBMED_CACHE_DIR="${PUBMED_CACHE_DIR:-$(mktemp -d)}"
PASS=0
FAIL=0

check() {
  local desc="$1"
  local expect="$2"
  local output="$3"
  if printf '%s' "$output" | grep -qF "$expect"; then
    echo "PASS: $desc"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $desc (expected \"$expect\" in output)"
    echo "--- output ---"
    printf '%s\n' "$output" | head -20
    FAIL=$((FAIL + 1))
  fi
}

check_exit() {
  local desc="$1"
  local expected="$2"
  local actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "PASS: $desc"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $desc (expected exit $expected, got $actual)"
    FAIL=$((FAIL + 1))
  fi
}

echo "== search =="
OUT=$("$CLI" search "glioblastoma[Title] AND MRI[Title]" --rows 2 --no-email-check)
check "search returns total count" '"total"' "$OUT"
check "search returns at least one result" '"pmid"' "$OUT"
check "search result has title" '"title"' "$OUT"
check "search returns query_translation" '"query_translation"' "$OUT"
check "search returns warnings array" '"warnings"' "$OUT"

echo "== search: 0 hits is a success =="
set +e
ERR=$(mktemp)
OUT=$("$CLI" search '"myocardial hemorrhage inflammatory index"[Title]' --rows 3 --no-email-check 2>"$ERR")
CODE=$?
set -e
check_exit "0-hit search exits 0" "0" "$CODE"
check "0-hit search reports total 0" '"total": 0' "$OUT"
check "0-hit search returns empty results" '"results": []' "$OUT"
check "0-hit search warns on stderr" 'QuotedPhraseNotFound' "$(cat "$ERR")"

OUT=$("$CLI" search '"D006333"[Mesh]' --explain --no-email-check)
check "explain reports QuotedPhraseNotFound" 'QuotedPhraseNotFound' "$OUT"

echo "== search: light modes =="
OUT=$("$CLI" search "heart failure" --count-only --no-email-check)
check "count-only returns a total" '"total"' "$OUT"
OUT=$("$CLI" search "glioblastoma[Title] AND MRI[Title]" --ids-only --rows 3 --no-email-check)
check "ids-only returns pmids" '"pmids"' "$OUT"

echo "== get-by-pmid =="
OUT=$("$CLI" get-by-pmid 28344011 --no-email-check)
check "get-by-pmid returns PMID" '"pmid": "28344011"' "$OUT"
check "get-by-pmid returns journal" '"journal"' "$OUT"
check "get-by-pmid returns abstract" '"abstract"' "$OUT"
check "get-by-pmid returns volume" '"volume"' "$OUT"
check "get-by-pmid returns pages" '"pages"' "$OUT"
check "get-by-pmid returns journal_abbrev" '"journal_abbrev"' "$OUT"

echo "== get-by-pmid: citation =="
OUT=$("$CLI" get-by-pmid 22828611 --format citation --no-email-check)
check "citation contains journal abbrev" "Br J Cancer" "$OUT"
check "citation contains volume/issue/pages" "107(4):695-9" "$OUT"
check "citation contains PMID" "PMID: 22828611" "$OUT"

echo "== get-by-pmid: batch =="
OUT=$("$CLI" get-by-pmid 22828611,28344011 --no-email-check)
check "batch returns results array" '"results"' "$OUT"
check "batch contains first PMID" '"pmid": "22828611"' "$OUT"
check "batch contains second PMID" '"pmid": "28344011"' "$OUT"

echo "== mesh =="
OUT=$("$CLI" mesh "Alzheimer Disease" --no-email-check)
check "mesh returns descriptor name" 'Alzheimer Disease' "$OUT"
check "mesh returns descriptor_ui" '"descriptor_ui"' "$OUT"
OUT=$("$CLI" mesh "Myocardial Infarction" --rows 1 --no-email-check)
check "mesh exact match comes first" '"name": "Myocardial Infarction"' "$OUT"
check "mesh reconstructs descriptor UI" '"descriptor_ui": "D009203"' "$OUT"

echo "== error handling =="
set +e
"$CLI" get-by-pmid not-a-pmid --no-email-check >/dev/null 2>&1
CODE=$?
set -e
if [ "$CODE" -ne 0 ]; then
  echo "PASS: invalid PMID exits non-zero"
  PASS=$((PASS + 1))
else
  echo "FAIL: invalid PMID should exit non-zero"
  FAIL=$((FAIL + 1))
fi

set +e
"$CLI" >/dev/null 2>&1
CODE=$?
set -e
if [ "$CODE" -ne 0 ]; then
  echo "PASS: missing command exits non-zero"
  PASS=$((PASS + 1))
else
  echo "FAIL: no command should exit non-zero"
  FAIL=$((FAIL + 1))
fi

OUT=$("$CLI" get-by-pmid 99999999999 --json-errors --no-email-check 2>/dev/null || true)
check "json-errors prints error JSON on stdout" '"error"' "$OUT"

"$CLI" --version >/dev/null 2>&1
echo "PASS: --version runs"
PASS=$((PASS + 1))

echo
echo "smoke test: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
