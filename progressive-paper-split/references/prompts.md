# Subagent prompts & coordinator recipe

> Referenced by `SKILL.md`. Copy/paste-ready material for batch processing a
> collection of paper directories with parallel subagents.

## Coordinator recipe (recommended: bundled runner)

```bash
SKILL="$HOME/.pi/agent/skills/progressive-paper-split"   # or the repo checkout
PARENT=/abs/path/to/collection                           # e.g. /home/limour/pi-rag/01

# 0) inventory
find "$PARENT" -maxdepth 2 -name full.md | sort

# 1) batch restructure (idempotent; logs under $PARENT/_batch/)
PARENT="$PARENT" bash "$SKILL/scripts/run_batch.sh"
# variants:
MAX=4 PARENT="$PARENT" bash "$SKILL/scripts/run_batch.sh"                       # more concurrency
PROVIDER=my-provider MODEL=my-model PARENT="$PARENT" bash "$SKILL/scripts/run_batch.sh"
PARENT="$PARENT" bash "$SKILL/scripts/run_batch.sh" 07 12                       # only specific papers
PROMPT_FILE=my_prompt.txt PARENT="$PARENT" bash "$SKILL/scripts/run_batch.sh"   # custom prompt template

# 2) regenerate the parent index from manifests
python3 "$SKILL/scripts/build_parent_index.py" "$PARENT" --title "<collection title>"
# optional: write a topic paragraph to $PARENT/INTRO.md (embedded automatically)

# 3) collection-wide verification
python3 "$SKILL/scripts/verify_links.py" "$PARENT"
```

The runner throttles to `MAX` (default 3) concurrent headless `pi -p` subagents,
sanitizes ambient `PI_*` session vars for each child, skips papers that already
have `_meta.md`, and records `START/OK/FAIL` lines in `$PARENT/_batch/runner.log`.

## Monitoring

```bash
cat "$PARENT/_batch/runner.log"          # orchestration timeline (START/OK/FAIL)
ls "$PARENT"/*/_meta.md | wc -l          # done count
# live per-paper progress — THE real signal (see lessons below):
for d in "$PARENT"/*/; do printf '%s: %s md files\n' "$d" "$(find "$d" -name '*.md' | wc -l)"; done
tail -f "$PARENT/_batch/logs/07.log"     # one agent's report — empty until it finishes!
```

## Operational lessons (from a 15-paper production run)

- **Logs stay empty until an agent completes** — `pi -p` prints only the final
  report to stdout. Judge live progress by files appearing in each paper dir.
- **Completion signal** = exit code 0 **and** `_meta.md` present. The `BATCH_DONE`
  line inside the report is informational (it can be truncated); the runner's
  OK/FAIL detection relies on `_meta.md`, not on log text.
- **Per-paper runtime varied 6–35 min.** Slow starters may write nothing for
  10+ minutes — that is normal. Only treat an agent as stuck when its process is
  dead or file counts stop growing for a long time. Don't kill early.
- **Child pi sessions must not inherit `PI_SESSION_ID`/`PI_SESSION_FILE`** —
  they could collide with the ambient session. The runner strips them and passes
  `--provider`/`--model` explicitly when configured. Proven flags:
  `--skill <dir> --no-session --approve --thinking low`.
- **Concurrency ≤3** kept API capacity comfortable for the whole run; raise
  `MAX` only if your quota allows.
- **Wall time ≈ ceil(papers / MAX) × avg 10–12 min** as a rough plan
  (14 papers at MAX=3 took ~90 min incl. several 30-min outliers).
- **Failures (none observed)** are retried by rerunning the runner — done
  papers are skipped automatically.

## Manual subagent prompt template

For interactive orchestration or non-pi harnesses: fill the four `{PLACEHOLDERS}`
(this is the same template embedded in `run_batch.sh`, field-proven):

```text
任务：按 skill progressive-paper-split 将一篇论文重构为渐进式披露结构。

论文目录（绝对路径）：{PAPER_DIR}
论文编号：{NN}
父集合目录：{PARENT_DIR}
skill 目录：{SKILL_DIR}

步骤：
1. 先加载并完整阅读 skill progressive-paper-split 的 SKILL.md 与 references/structure.md。
2. 完整读取 {PAPER_DIR}/full.md（分页读完），按 SKILL.md 的 Subagent workflow 拆分：
   front-matter / introduction / methods / results（每个结果一个 MD）/ tables / figures /
   discussion / references / back-matter，并写入 {PAPER_DIR}/INDEX.MD（Level 1 入口，链接全部文件）。
3. 写入 {PAPER_DIR}/_meta.md（manifest，模板见 references/structure.md；title 单行；在 meta fence 写入 one_liner（单行、≤110 字、含关键数值的单一核心结论，用于父索引表格）；摘要 ≤ 300 词并保留关键数值）。
4. 自检必须通过（退出码 0）：
   python3 {SKILL_DIR}/scripts/verify_links.py {PAPER_DIR}
5. 汇报：创建的文件清单、verify 输出、未决问题（如未引用的图片）。

硬约束：
- 只在 {PAPER_DIR} 内读写；禁止修改兄弟论文目录或 {PARENT_DIR}/INDEX.MD（父索引由协调者统一生成）。
- 禁止删除或改动 full.md 与 images/；图片一律以 ../images/<文件> 引用。
- 表格 HTML 逐字保留；数值/统计量/作者名不得改动；仅修复明显 OCR 断词与双栏错位拼接。
- 无用户交互环境：不要使用 ask_user_question；歧义处自主合理决策并注明；不要使用浏览器工具。
- 若 {PAPER_DIR} 已存在 _meta.md，说明已处理，直接报告并退出（幂等）。
```

## Launching with other harnesses

- **pi SDK**: run each prompt as an isolated session (see pi `docs/sdk.md`);
  each session sees only its paper directory in the prompt; no shared file writes.
- **Any agent CLI**: same prompt; ensure the skill files are readable at `{SKILL_DIR}`
  and unset any ambient session-identity env vars before spawning children.

### Why this is parallel-safe

- Subagents write only inside `PARENT/NN/` (their tree + `INDEX.MD` + `_meta.md`).
- The single shared artifact `PARENT/INDEX.MD` is written **once**, after all
  subagents finish, by `build_parent_index.py` — derived purely from `_meta.md`
  manifests, so reruns are deterministic and idempotent.
- `verify_links.py` is read-only.

### Retrying failures

A failed subagent leaves no `_meta.md`, so simply rerun the runner — done papers
are skipped automatically. If a paper's tree is partially written, delete its
generated files (keep `full.md` + `images/`) and rerun:

```bash
cd "$PARENT/$NN" && rm -rf front-matter introduction methods results tables figures discussion references back-matter INDEX.MD _meta.md
```
