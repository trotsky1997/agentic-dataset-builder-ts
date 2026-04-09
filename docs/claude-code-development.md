# Claude Code Development Guide

This guide is for Claude Code or any AI coding assistant working inside `agentic-dataset-builder-ts`.

## Main goal

Keep the package as a pure TypeScript CLI that:

- reads local Pi, Codex, and Claude Code history
- validates normalized records with Zod
- labels records for training use
- writes one final `dataset.parquet`

Do not reintroduce Python runtime dependencies into the main CLI path.

## Ground rules

- Keep the main runtime pure Node.js + TypeScript.
- Use `Zod` for schema validation.
- Prefer extending the existing parser/label/merge pipeline over adding one-off scripts.
- Preserve the user-facing contract:
  - one command
  - one final parquet
  - one manifest
  - one run log
- Treat Claude as `prompt_only` unless full assistant/tool traces become available locally.

## Repository map

- `src/cli.ts`
  - main entrypoint
- `src/schemas/qwen35.ts`
  - final normalized dataset schema
- `src/schemas/source.ts`
  - source event schemas
- `src/sources/pi.ts`
  - Pi parser
- `src/sources/codex.ts`
  - Codex parser
- `src/sources/claude.ts`
  - Claude prompt-only parser
- `src/labeling.ts`
  - label assignment
- `src/parquet.ts`
  - parquet writer
- `src/platform/paths.ts`
  - Linux/macOS/Windows source path detection

## Standard workflow

Install and validate before changing behavior:

```bash
npm install
npm run test
npm run check
npm run build
```

Run a focused local build when touching a parser:

```bash
# Pi only
node dist/cli.js --output-root ./out-pi --include-sources pi --include-labels cot_eligible,agent_only

# Codex only
node dist/cli.js --output-root ./out-codex --include-sources codex --include-labels cot_eligible,agent_only,prompt_only

# Claude only
node dist/cli.js --output-root ./out-claude --include-sources claude --include-labels prompt_only
```

## What to test when editing

If you change schemas:

- run `npm run test`
- run `npm run check`
- make sure new fields are reflected in both schema and output code

If you change a parser:

- add or update a parser test
- run one focused CLI build for that source
- confirm the output still writes `dataset.parquet`

If you change path detection:

- update `src/platform/paths.test.ts`
- check Linux/macOS/Windows candidate behavior stays explicit

## Labels

Current label meanings:

- `cot_eligible`
  - agentic trace with visible reasoning
- `agent_only`
  - agentic trace without visible reasoning
- `prompt_only`
  - history-only source, currently Claude
- `discard`
  - below the configured usefulness threshold

Do not silently change label semantics without updating tests and README.

## Release checklist

Before publishing:

```bash
npm run test
npm run check
npm run build
npm pack --dry-run
```

Then:

1. bump `package.json` version
2. update README command examples if version is pinned there
3. publish to npm
4. push the branch/merge to main

## Known caveats

- Codex histories can contain malformed JSONL lines; readers should skip or isolate bad lines instead of crashing the full run.
- Codex developer messages may appear after non-system messages; they must not be emitted as invalid late `system` messages.
- Claude local data currently exposes prompt history more reliably than full assistant/tool traces.
- The npm tarball should contain runtime files only; avoid shipping tests if possible.
