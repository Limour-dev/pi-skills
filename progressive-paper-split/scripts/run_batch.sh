#!/usr/bin/env bash
# run_batch.sh — restructure paper directories with parallel headless pi subagents.
#
# Field-tested: 14 papers, concurrency 3, all OK, ~90 min wall time
# (per-paper range 6–35 min, 515 MD files, 0 broken links collection-wide).
#
# Usage:
#   PARENT=/abs/path/to/collection bash run_batch.sh [NN ...]
#
# Env configuration (all optional):
#   SKILL_DIR   skill directory              (default: parent dir of this script)
#   PARENT      collection parent directory  (required; papers = subdirs with full.md)
#   MAX         max concurrent subagents     (default: 3)
#   PI_BIN      pi executable                (default: `command -v pi`)
#   PROVIDER    --provider flag value        (default: unset -> pi/env default)
#   MODEL       --model flag value           (default: unset)
#   THINKING    --thinking flag value        (default: low)
#   PROMPT_FILE prompt template file with {PAPER_DIR} {NN} {PARENT} {SKILL_DIR}
#               placeholders                 (default: embedded field-proven prompt)
#
# Idempotent: papers that already have _meta.md are skipped.
# Outputs: $PARENT/_batch/runner.log (timeline), $PARENT/_batch/logs/NN.log (per paper).
set -u

SKILL_DIR="${SKILL_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
: "${PARENT:?error: PARENT=<collection dir> is required}"
MAX="${MAX:-3}"
PI_BIN="${PI_BIN:-$(command -v pi || true)}"
THINKING="${THINKING:-low}"
BATCH="$PARENT/_batch"
LOGS="$BATCH/logs"
mkdir -p "$LOGS"
cd "$PARENT" || exit 1

[ -n "$PI_BIN" ] || { echo "error: pi not found in PATH (set PI_BIN)"; exit 1; }
[ -f "$SKILL_DIR/SKILL.md" ] || { echo "error: SKILL_DIR has no SKILL.md: $SKILL_DIR"; exit 1; }

# ---- candidate papers: CLI args > $PAPERS env > auto-detect (subdirs with full.md) ----
if [ "$#" -gt 0 ]; then
  CANDIDATES="$*"
elif [ -n "${PAPERS:-}" ]; then
  CANDIDATES="$PAPERS"
else
  CANDIDATES="$(for d in */; do d="${d%/}"; [ -f "$d/full.md" ] && echo "$d"; done)"
fi

PENDING=""
for NN in $CANDIDATES; do
  if [ ! -f "$PARENT/$NN/full.md" ]; then
    echo "skip $NN (no $NN/full.md)"; continue
  fi
  if [ -f "$PARENT/$NN/_meta.md" ]; then
    echo "skip $NN (already done: _meta.md present)"; continue
  fi
  PENDING="$PENDING $NN"
done
if [ -z "${PENDING// /}" ]; then
  echo "[$(date '+%F %T')] nothing to do"
  exit 0
fi

echo "[$(date '+%F %T')] BATCH START pending:$PENDING max_jobs:$MAX provider:${PROVIDER:-<env/default>} model:${MODEL:-<env/default>} thinking:$THINKING"

# ---- default prompt: the field-proven template (placeholders substituted per paper) ----
default_prompt() {
cat <<'EOF'
任务：按 skill progressive-paper-split 将一篇论文重构为渐进式披露结构。

论文目录（绝对路径）：{PAPER_DIR}
论文编号：{NN}
父集合目录：{PARENT}
skill 目录：{SKILL_DIR}

步骤：
1. 先用 read 完整阅读 {SKILL_DIR}/SKILL.md 与 {SKILL_DIR}/references/structure.md，严格遵循。
2. 完整读取 {PAPER_DIR}/full.md（用 offset 分页直到读完全部内容），按 skill 的 Subagent workflow 拆分：
   front-matter / introduction / methods / results（每个结果一个 MD）/ tables（每表一个 MD）/ figures（每图一个 MD）/ discussion / references / back-matter，
   并写入 {PAPER_DIR}/INDEX.MD（Level 1 入口：速览表、摘要、核心结论、链接全部拆分文件；图片一律以 ../images/<文件> 引用）。
3. 写入 {PAPER_DIR}/_meta.md（manifest，模板见 {SKILL_DIR}/references/structure.md；title 单行；在 meta fence 写入 one_liner（单行、≤110 字、含关键数值的单一核心结论，用于父索引表格）；摘要 ≤ 300 词并保留关键数值）。
4. 自检必须通过（退出码 0）：python3 {SKILL_DIR}/scripts/verify_links.py {PAPER_DIR}
   若有断链，修复后重跑自检直到退出码 0。
5. 最后输出一行总结：BATCH_DONE {NN} <创建文件数> <verify: 0 broken links>。

硬约束：
- 只在 {PAPER_DIR} 内读写；禁止修改兄弟论文目录或 {PARENT}/INDEX.MD、{PARENT}/INTRO.md。
- 禁止删除或改动 full.md 与 images/ 内文件。
- 表格 HTML 逐字保留；数值/统计量/置信区间/P值/作者名不得改动；仅修复明显 OCR 断词（如 mvocardial→myocardial）与双栏排版错位（拼接被截断的段落/参考文献）。
- 无用户交互环境：不要使用 ask_user_question；歧义处按最合理方式自行决定并在总结中注明；不要使用浏览器工具。
EOF
}

run_one() {
  local NN="$1"
  local PAPER_DIR="$PARENT/$NN"
  local LOG="$LOGS/$NN.log"
  local PROMPT
  if [ -n "${PROMPT_FILE:-}" ]; then
    PROMPT="$(cat "$PROMPT_FILE")"
  else
    PROMPT="$(default_prompt)"
  fi
  PROMPT="$(printf '%s' "$PROMPT" | sed \
    -e "s|{PAPER_DIR}|$PAPER_DIR|g" \
    -e "s|{NN}|$NN|g" \
    -e "s|{PARENT}|$PARENT|g" \
    -e "s|{SKILL_DIR}|$SKILL_DIR|g")"

  local EXTRA=()
  [ -n "${PROVIDER:-}" ] && EXTRA+=(--provider "$PROVIDER")
  [ -n "${MODEL:-}" ] && EXTRA+=(--model "$MODEL")

  echo "[$(date '+%F %T')] START $NN"
  # Strip session-identity vars so child sessions cannot collide with any
  # ambient pi session; provider/model env is left intact as a fallback
  # (explicit flags win when PROVIDER/MODEL are set).
  env -u PI_SESSION_ID -u PI_SESSION_FILE -u PI_WEB_HOSTNAME \
      -u PI_FFF_MODE -u PI_REASONING_LEVEL \
    "$PI_BIN" -p "$PROMPT" \
      ${EXTRA[@]+"${EXTRA[@]}"} \
      --skill "$SKILL_DIR" --no-session --approve --thinking "$THINKING" \
    > "$LOG" 2>&1
  local rc=$?
  if [ -f "$PAPER_DIR/_meta.md" ]; then
    echo "[$(date '+%F %T')] OK    $NN (rc=$rc, _meta.md present)"
  else
    echo "[$(date '+%F %T')] FAIL  $NN (rc=$rc, no _meta.md — see $LOG)"
  fi
}

for NN in $PENDING; do
  # throttle: keep at most MAX background jobs running
  while [ "$(jobs -rp | wc -l)" -ge "$MAX" ]; do sleep 5; done
  run_one "$NN" &
  sleep 1
done
wait
echo "[$(date '+%F %T')] BATCH COMPLETE ($(ls "$PARENT"/*/_meta.md 2>/dev/null | wc -l) papers with _meta.md)"
