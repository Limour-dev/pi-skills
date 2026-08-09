#!/usr/bin/env bash
# Smoke test for hn-briefing — verifies each subcommand works against the live API.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="$DIR/bin/hn-briefing"

echo "== top 5 =="
"$BIN" top 5 | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const a=JSON.parse(d);console.log('count',a.length,'first',a[0].title)})"

echo "== top 5 by-score =="
"$BIN" top --by-score 5 | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const a=JSON.parse(d);console.log('count',a.length,'topScore',a[0].score)})"

echo "== item =="
"$BIN" item 49228663 | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const s=JSON.parse(d);console.log('id',s.id,'title',s.title)})"

echo "== content =="
"$BIN" content https://example.com | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const s=JSON.parse(d);console.log('url',s.url,'textLen',s.text.length)})"

echo "OK"