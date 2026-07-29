# pi-skills

A collection of [Agent Skills](https://agentskills.io/) for [pi](https://github.com/badlogic/pi),
Claude Code, Codex, Cursor, and any other agent that follows the Agent Skills standard.

## Skills

| Skill | Description |
| ----- | ----------- |
| [pdf](pdf/) | Read, create, and review PDF files where layout matters. Generates with `reportlab`, extracts with `pdfplumber`/`pypdf`, and verifies by rendering pages to PNG. |

## Install

Install the whole collection:

```bash
npx skills add Limour-dev/pi-skills
```

Or a single skill explicitly:

```bash
npx skills add Limour-dev/pi-skills --skill pdf
```

## License

[Apache-2.0](LICENSE)
