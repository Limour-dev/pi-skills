---
disable-model-invocation: true
name: "pdf"
description: "Read, create, and review PDF files where layout matters. Use for any PDF task: generate with reportlab, extract with pdfplumber/pypdf, and verify by rendering pages to PNG."
---


# PDF Skill

## Workflow
1. Generate new documents with `reportlab`.
2. Extract text / quick checks with `pdfplumber` (or `pypdf`) — does not preserve layout.
3. Verify visually and re-render after each meaningful change:
   - Render pages: `pdftoppm -png $INPUT_PDF $OUTPUT_PREFIX`
   - If `pdftoppm` or a Python import is missing, see [references/setup.md](references/setup.md).

## Conventions
- Intermediate files in `tmp/pdfs/` (delete when done); final artifacts in `output/pdf/`.
- Keep filenames stable and descriptive.

## Quality bar
- No delivery until PNG inspection shows zero defects: no clipped/overlapping text, broken tables, black squares, or unreadable glyphs.
- Consistent typography, spacing, margins, and hierarchy; charts/tables/images sharp, aligned, and labeled; headers/footers and page numbering polished.
- ASCII hyphens only (no U+2011 or other Unicode dashes); human-readable citations, never tool tokens or placeholders.
