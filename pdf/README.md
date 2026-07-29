# pdf

An [Agent Skill](https://agentskills.io/) for reading, creating, and reviewing PDF
files where layout and rendering matter. Generates with `reportlab`, extracts with
`pdfplumber`/`pypdf`, and verifies results by rendering pages to PNG.

Works with [pi](https://github.com/badlogic/pi), Claude Code, Codex, Cursor, and any
other agent that follows the Agent Skills standard.

Part of the [Limour-dev/pi-skills](https://github.com/Limour-dev/pi-skills) collection.

## Install

Install the whole collection:

```bash
npx skills add Limour-dev/pi-skills
```

Or just this skill:

```bash
npx skills add Limour-dev/pi-skills --skill pdf
```

## Usage

The skill loads on demand when a task involves PDFs. It follows progressive
disclosure:

1. Only the `name` + `description` are always in context.
2. The agent reads `SKILL.md` when a PDF task matches.
3. Dependency setup (`references/setup.md`) is read only when a tool or import is
   missing.

Force it with `/skill:pdf` in agents that support skill commands.

## Requirements

- Python: `reportlab`, `pdfplumber`, `pypdf`
- System: `pdftoppm` (Poppler) for rendering pages to images

See [references/setup.md](references/setup.md) for installation commands.

## Repository layout

This skill lives in the `pdf/` folder of the `pi-skills` monorepo:

```
pdf/
├── SKILL.md              # Skill definition (frontmatter + instructions)
├── references/
│   └── setup.md          # One-time dependency installation
├── agents/
│   └── openai.yaml       # OpenAI agent interface metadata
├── assets/
│   └── pdf.png           # Icon
└── LICENSE               # Apache-2.0
```

## License

[Apache-2.0](LICENSE)
