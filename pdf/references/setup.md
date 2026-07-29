# PDF Skill — First-time Setup

One-time dependency installation. Only needed on first use, or when a required
command/package is missing. Return to [../SKILL.md](../SKILL.md) for the workflow.

## Python packages

Prefer `uv` for dependency management:

```
uv pip install reportlab pdfplumber pypdf
```

If `uv` is unavailable:

```
python3 -m pip install reportlab pdfplumber pypdf
```

## System tools (for rendering)

```
# macOS (Homebrew)
brew install poppler

# Ubuntu/Debian
sudo apt-get install -y poppler-utils
```

## If installation isn't possible

If installation isn't possible in this environment, tell the user which
dependency is missing and how to install it locally.

## Environment

No required environment variables.
