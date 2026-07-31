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
PASS=0
FAIL=0

check() {
  local desc="$1"
  local expect="$2"
  local output="$3"
  if printf '%s' "$output" | grep -q "$expect"; then
    echo "PASS: $desc"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $desc (expected \"$expect\" in output)"
    echo "--- output ---"
    printf '%s\n' "$output" | head -20
    FAIL=$((FAIL + 1))
  fi
}

echo "== search =="
OUT=$("$CLI" search "glioblastoma[Title] AND MRI[Title]" --rows 2 --no-email-check)
check "search returns total count" '"total"' "$OUT"
check "search returns at least one result" '"pmid"' "$OUT"
check "search result has title" '"title"' "$OUT"

echo "== get-by-pmid =="
OUT=$("$CLI" get-by-pmid 28344011 --no-email-check)
check "get-by-pmid returns PMID" '"pmid": "28344011"' "$OUT"
check "get-by-pmid returns journal" '"journal"' "$OUT"
check "get-by-pmid returns abstract" '"abstract"' "$OUT"

echo "== mesh =="
OUT=$("$CLI" mesh "Alzheimer Disease" --no-email-check)
check "mesh returns descriptor name" 'Alzheimer Disease' "$OUT"
check "mesh returns UI" '"mesh_id"' "$OUT"

echo "== error handling =="
if "$CLI" get-by-pmid not-a-pmid --no-email-check >/dev/null 2>&1; then
  echo "FAIL: invalid PMID should exit non-zero"
  FAIL=$((FAIL + 1))
else
  echo "PASS: invalid PMID exits non-zero"
  PASS=$((PASS + 1))
fi
if "$CLI" >/dev/null 2>&1; then
  echo "FAIL: no command should exit non-zero"
  FAIL=$((FAIL + 1))
else
  echo "PASS: missing command exits non-zero"
  PASS=$((PASS + 1))
fi
"$CLI" --version >/dev/null 2>&1
echo "PASS: --version runs"
PASS=$((PASS + 1))

echo
echo "smoke test: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
