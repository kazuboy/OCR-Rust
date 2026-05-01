# OCR-Rust (Gemini OCR+)

Gemini OCR+ is a Windows desktop application for OCR extraction and AI-assisted file organization, built with Tauri (Rust) and Next.js.

## About

Gemini OCR+ supports multi-format extraction output (TXT/MD/CSV/JSON), prompt templates, and practical post-processing such as translation, summarization, and PII masking.  
Windows installers are distributed through GitHub Releases.

## Features

- OCR extraction from documents and images
- Output formats: TXT / Markdown / CSV / JSON
- Optional YAML Frontmatter for Markdown
- Custom prompt templates (save / edit / delete)
- Advanced output processing:
  - Translation output mode
  - Summary modes (3 bullets / conclusion only)
  - PII masking
  - Auto tag generation
- AI-assisted file organization and rule-based renaming
- Exact duplicate detection and removal
- Move selected files to Recycle Bin

## Stack

- Frontend: Next.js 16, React 19, TypeScript
- Desktop: Tauri v2 + Rust
- AI: Gemini API
- Storage: SQLite (rusqlite)

## Requirements

- Node.js 20+
- Rust stable
- Windows 10/11 (recommended)

## Setup

```bash
npm ci
```

Configure Gemini API key in either of these ways:

- Save it from the in-app model settings dialog
- Set environment variable `GEMINI_API_KEY`

## Development

Run web UI only:

```bash
npm run dev
```

Run as desktop app (Tauri):

```bash
npm run tauri dev
```

## Build (Local)

```bash
npm run tauri:build
```

Windows installer is typically generated at:

- `src-tauri/target/release/bundle/nsis/*.exe`

## GitHub Release (Windows EXE)

This repository includes a release workflow:

- Workflow file: `.github/workflows/release.yml`
- Trigger: pushing tags matching `v*`

Example:

```bash
git tag -a v0.1.1 -m "Release v0.1.1"
git push origin main
git push origin v0.1.1
```

The workflow builds release binaries and attaches:

- Windows installer artifact(s)
- `SHA256SUMS.txt` checksum file

## Security Notes

- File operations in Rust are scoped to allowed local roots.
- Proposed names and paths are validated before filesystem operations.
- Move operations prefer `rename` first and use safe fallback behavior to reduce inconsistency.

## Notes

- `api_key.txt` is ignored by `.gitignore`; do not commit secrets.
- `src/app/renamer` currently redirects to `filing`.
