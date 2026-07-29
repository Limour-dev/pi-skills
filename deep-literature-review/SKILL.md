---
name: deep-literature-review
description: Deep-read, cross-compare, and gap-analyze a progressive-disclosure paper corpus (produced by progressive-paper-split or similar). Enforces multi-layer reading beyond top-level indexes — methods, results tables, discussion cross-references — then produces structured comparisons (definitions, effect sizes, study design, inter-paper citations) and evidence-based recommendations for missing literature. Use when asked to compare papers, do a literature review across a corpus, identify gaps in a collection, or suggest papers to add.
---

# Deep Literature Review

Perform a rigorous, multi-layer comparative analysis of a paper corpus structured as progressive-disclosure trees (one folder per paper, each with `INDEX.MD`, split chapter files, tables, figures, discussion). Produce: (1) a deep cross-paper comparison, (2) an inter-paper citation/dialogue map, (3) evidence-based recommendations for literature to add.

**Core principle: INDEX files are navigation aids, not content. An analysis built only on abstracts is a summary, not a review.**

---

## ⛔ Anti-laziness contract (read first)

Before producing ANY comparative output, you MUST have read files from **all three depth tiers** below for **every paper in the corpus**. If the corpus has N papers, you need ≥ 3×N targeted file reads minimum (more for large or heterogeneous corpora).

| Tier | What to read | Why it matters |
|------|-------------|----------------|
| **Tier 0 — Navigation** | `PARENT/INDEX.MD`, each `NN/INDEX.MD` | Get titles, abstracts, structure map. This is the ONLY tier lazy agents read. It is necessary but never sufficient. |
| **Tier 1 — Methods & Definitions** | `methods/*.md` (at least the primary methodology file per paper: CMR protocol, statistical model, assay, animal model, etc.) | Definitions of the outcome variable, measurement techniques, and analytic framework differ across papers and drive all downstream differences. You cannot compare what you haven't defined. |
| **Tier 2 — Results & Evidence** | `results/*.md` (key results), `tables/*.md` (regression tables, baseline characteristics), `figures/*.md` (when data-bearing) | Effect sizes, confidence intervals, model performance metrics, subgroup findings — the actual evidence. Abstracts round, omit, or flatten these. |
| **Tier 3 — Interpretation & Dialogue** | `discussion/discussion.md`, `discussion/limitations.md`, `discussion/conclusions.md` | Authors explicitly compare their work to prior studies, cite specific papers, explain discrepancies, and state what remains unknown. This is where inter-paper dialogue and gap signals live. |

**Verification checkpoint:** Before writing your analysis, confirm you can answer these questions for each paper WITHOUT re-reading the abstract:
- What exact definition/cut-off was used for the primary outcome?
- What was the multivariable effect size (OR/HR/AUC) with 95% CI?
- What specific prior studies did the authors cite in their discussion, and did they agree or disagree?
- What did the authors state as their top 2 limitations?

If you cannot answer all four, you haven't read deeply enough. Go back.

---

## Workflow

### Phase 1 — Corpus orientation (Tier 0)

1. Read `PARENT/INDEX.MD` (or equivalent top-level index). Note: total paper count, topic scope, any stated theme or collection description.
2. Read every `NN/INDEX.MD`. Build a mental or scratch-note table:
   - Paper ID, title, journal, year, study design, sample size, primary outcome, key finding.
3. Identify the **comparison dimensions** relevant to this corpus. Common ones (adapt to topic):
   - Outcome definition and measurement method
   - Study design hierarchy (RCT > prospective > retrospective > animal > review)
   - Sample size, single/multi-center, internal/external validation
   - Effect sizes and model performance
   - Mechanistic vs. clinical vs. modeling focus
   - Follow-up duration and endpoints

### Phase 2 — Deep reading (Tiers 1–3)

**Batch-read efficiently:** group reads by file type across papers when possible. Suggested order:

1. **Methods sweep**: Read the primary methods file from every paper. Focus on:
   - Outcome variable definition (e.g., imaging sequence + cut-off, assay + threshold, scoring system)
   - Measurement timing (acute vs. subacute vs. chronic)
   - Statistical framework (logistic regression, Cox, ML algorithm, mixed model)
   - Inclusion/exclusion criteria that shape the population

2. **Results sweep**: Read key results files and regression/performance tables. Extract into a structured comparison matrix:
   - Independent predictors and their OR/HR (95% CI, P)
   - Model AUC/C-index with validation type
   - Incidence/prevalence of the outcome
   - Subgroup or stratified findings

3. **Discussion sweep**: Read every `discussion/discussion.md` and `discussion/limitations.md`. Extract:
   - Which other papers in the corpus (or outside it) are explicitly cited, and whether the authors agree/disagree/extend
   - Stated explanations for discrepancies with prior work
   - Mechanistic hypotheses proposed
   - Self-acknowledged limitations (sample size, design, generalizability, measurement)
   - Explicit "future research needed" statements

**Minimum read budget per paper:** 4 files (1 methods + 1 results/table + 1 discussion + INDEX). For papers central to the comparison (e.g., the only animal study, the only ML study, the largest cohort), read more: additional results subsections, supplementary methods, specific figures/tables.

### Phase 3 — Structured comparison

Produce the comparison in these sections (adapt headings to corpus topic):

#### 3.1 Methodology comparison table
One row per paper. Columns: design, N, centers, outcome definition, measurement method, timing, statistical approach, validation type. Flag methodological heterogeneity that affects cross-study comparability (e.g., different imaging sequences yielding different incidence rates).

#### 3.2 Effect-size / evidence matrix
Group by comparison dimension (e.g., by predictor category, by outcome). For each predictor or model: which papers studied it, what effect size they found, whether they agree or conflict. Note when discrepancies are explained by population, definition, or design differences.

#### 3.3 Inter-paper citation and dialogue map
Which papers cite which (within and outside the corpus). Where do they explicitly agree, disagree, or extend each other? Present as a table or directed list. This reveals the intellectual structure of the field.

#### 3.4 Evidence chain / knowledge graph
Synthesize how findings connect mechanistically: Risk factor → biological pathway → intermediate phenotype → outcome → clinical consequence. Identify which links have clinical evidence, which have only animal evidence, and which are hypothesized.

#### 3.5 Study quality and limitation cross-tabulation
Compare strengths and weaknesses across papers. Note which limitations are shared (e.g., all retrospective) vs. unique. Assess whether the corpus has adequate coverage of prospective, multi-center, externally validated, and mechanistic evidence.

### Phase 4 — Gap analysis and literature recommendations

Based on the deep reading, identify structural gaps. For each gap:

1. **State the gap** (what topic/method/evidence type is missing).
2. **Cite the internal evidence** — which papers in the corpus point to this gap (specific discussion quotes, cited-but-absent references, "future research" statements).
3. **Recommend specific literature** — name the paper (authors, title, journal, year) if identifiable from the corpus's own reference lists, or describe the type of study needed. Prioritize:
   - Papers repeatedly cited across multiple corpus members but not included (high-frequency missing references)
   - Foundational/seminal papers that the corpus's arguments depend on
   - Systematic reviews or meta-analyses (if none exist in the corpus)
   - Interventional studies (if the corpus is entirely observational)
   - Method/validation studies (if measurement heterogeneity is a problem)
4. **Assign priority** (🔴 essential / 🟡 important / 🟢 nice-to-have) with justification.

Provide a "if you can only add N papers" shortlist for N = 3 and N = 5.

### Phase 5 — Output format

Deliver as a single structured markdown document. Use tables extensively. Every claim about a paper's content must be traceable to a specific file you read (e.g., "Paper 04's discussion notes CX collaterals are lowest at 14% — from `04/discussion/discussion.md`"). Do not make claims based solely on abstracts when you have read the full text.

---

## Common failure modes (avoid these)

| Failure | Symptom | Fix |
|---------|---------|-----|
| **Abstract-only analysis** | Comparison restates abstracts; no effect sizes, no methodology differences, no citation dialogue | Enforce Tier 1–3 reads before writing. If your comparison has no OR/CI numbers, you failed. |
| **Homogeneous treatment** | All papers described in the same template regardless of type | Animal studies, ML models, RCTs, and reviews need different comparison axes. Adapt. |
| **Missing-method blindness** | Outcome incidence compared across papers using different definitions without noting it | Always compare definitions before comparing numbers. A 16% vs. 54% incidence gap is a methods finding, not just a results finding. |
| **Citation amnesia** | No mention of which papers cite each other | Discussion sections contain explicit cross-references. Extract them. This is the field's own map. |
| **Generic gap analysis** | "More research is needed" without specifying what | Every gap must be grounded in a specific paper's stated limitation or cited-but-missing reference. |
| **Lazy recommendation** | Suggesting "a review paper" without naming one | Mine the reference lists in `references/references.md` of each paper. High-frequency cited references not in the corpus are your top candidates. |

---

## Adaptation notes

- **Corpus not from progressive-paper-split?** The workflow still applies. Map: top-level index → per-paper structure → methods/results/discussion. If papers are single `full.md` files, read them in section order (methods → results → discussion), not top-to-bottom.
- **Large corpus (>20 papers)?** Prioritize: read Tier 1–3 for the 8–10 most central papers (by sample size, citation frequency, or methodological uniqueness); read Tier 0 + selective Tier 1 for the rest. State your sampling strategy explicitly.
- **Single-topic corpus (all papers on the same question)?** The comparison dimensions narrow (e.g., all predict the same outcome). Focus on: definition heterogeneity, effect-size concordance/discordance, incremental value of each predictor, and model validation quality.
- **Multi-topic corpus?** Add a clustering step in Phase 1: group papers by sub-topic, then compare within and across clusters.

---

## Reference

- [references/comparison-template.md](references/comparison-template.md) — ready-to-fill markdown template for the comparison output, with section prompts and example rows.
- [references/reading-checklist.md](references/reading-checklist.md) — per-paper reading log template to track Tier 0–3 completion and key extractions.
