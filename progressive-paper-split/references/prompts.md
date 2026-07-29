# Subagent prompts & coordinator recipe

> Referenced by `SKILL.md`. Copy/paste-ready material for batch processing a
> collection of paper directories with parallel subagents.

## Subagent prompt template

Fill the four `{PLACEHOLDERS}` and hand this to one subagent:

```text
任务：按 skill `progressive-paper-split` 将一篇论文重构为渐进式披露结构。

论文目录（绝对路径）：{PAPER_DIR}
论文编号：{NN}
父集合目录：{PARENT_DIR}
skill 目录：{SKILL_DIR}

步骤：
1. 先加载并完整阅读 skill `progressive-paper-split` 的 SKILL.md 与 references/structure.md。
2. 完整读取 {PAPER_DIR}/full.md（分页读完），按 SKILL.md 的 Subagent workflow 拆分：
   front-matter / introduction / methods / results（每个结果一个 MD）/ tables / figures /
   discussion / references / back-matter，并写入 {PAPER_DIR}/INDEX.MD（Level 1 入口，链接全部文件）。
3. 写入 {PAPER_DIR}/_meta.md（manifest，模板见 references/structure.md；摘要 ≤ 300 词并保留关键数值）。
4. 自检必须通过（退出码 0）：
   python3 {SKILL_DIR}/scripts/verify_links.py {PAPER_DIR}
5. 汇报：创建的文件清单、verify 输出、未决问题（如未引用的图片）。

硬约束：
- 只在 {PAPER_DIR} 内读写；禁止修改兄弟论文目录或 {PARENT_DIR}/INDEX.MD（父索引由协调者统一生成）。
- 禁止删除或改动 full.md 与 images/；图片一律以 ../images/<文件> 引用。
- 表格 HTML 逐字保留；数值/统计量/作者名不得改动；仅修复明显 OCR 断词与双栏错位拼接。
- 若 {PAPER_DIR} 已存在 _meta.md，说明已处理，直接报告并退出（幂等）。
```

## Coordinator recipe

```bash
SKILL="$HOME/.pi/agent/skills/progressive-paper-split"
PARENT=/abs/path/to/collection          # e.g. /home/limour/pi-rag/01

# 0) inventory
find "$PARENT" -maxdepth 2 -name full.md | sort

# 1) launch one subagent per pending paper (concurrency 3–5 recommended)
for NN in 02 03 04 05 06 07 08 09 10 11 12 13 14 15; do
  [ -f "$PARENT/$NN/_meta.md" ] && continue      # idempotent: skip done papers
  launch_subagent "$(cat <<EOF
<the filled subagent prompt above, PAPER_DIR=$PARENT/$NN, NN=$NN,
 PARENT_DIR=$PARENT, SKILL_DIR=$SKILL>
EOF
)" &
  # throttle: keep at most 5 concurrent jobs (e.g. `while [ $(jobs -r | wc -l) -ge 5 ]; do sleep 1; done`)
done
wait

# 2) regenerate the parent index from manifests
python3 "$SKILL/scripts/build_parent_index.py" "$PARENT" \
  --title "论文集总索引（01–15）— <collection topic>"
# optional: write a topic paragraph to $PARENT/INTRO.md (embedded automatically)

# 3) collection-wide verification
python3 "$SKILL/scripts/verify_links.py" "$PARENT"
```

`launch_subagent` = whatever your harness provides:

- **pi (interactive)**: spawn via your usual task/subagent mechanism, one task per paper.
- **pi SDK**: see pi docs `docs/sdk.md` — run each prompt as an isolated session
  (each session sees only its paper directory in the prompt; no shared file writes).
- **pi CLI headless**: `pi --print "<prompt>"` per paper as background jobs, if your
  pi build supports non-interactive mode (check `pi --help`).

### Why this is parallel-safe

- Subagents write only inside `PARENT/NN/` (their tree + `INDEX.MD` + `_meta.md`).
- The single shared artifact `PARENT/INDEX.MD` is written **once**, after all
  subagents finish, by `build_parent_index.py` — derived purely from `_meta.md`
  manifests, so reruns are deterministic and idempotent.
- `verify_links.py` is read-only.

### Retrying failures

A failed subagent leaves no `_meta.md`, so simply rerun the loop — done papers are
skipped automatically. If a paper's tree is partially written, delete its generated
folders (keep `full.md` + `images/`) and rerun:

```bash
cd "$PARENT/$NN" && rm -rf front-matter introduction methods results tables figures discussion references back-matter INDEX.MD _meta.md
```
