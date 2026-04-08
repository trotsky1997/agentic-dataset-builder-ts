# Agentic Dataset Builder

Pure TypeScript CLI for turning local Pi, Codex, and Claude Code history into one validated `dataset.parquet` file.

## Goal

Use this repo when you want an AI coding assistant to do one job end-to-end:

1. discover local session history
2. normalize it into the local Qwen35-compatible schema
3. label records by training use
4. write one final parquet dataset

The CLI is native Node.js + TypeScript. It does not require Python.

## Fastest path

If the package is published on npm:

```bash
npx --registry=https://registry.npmjs.org/ agentic-dataset-builder@0.2.3 --output-root ./out
```

If working from this repo locally:

```bash
npm install
npm run build
node dist/cli.js --output-root ./out
```

## What the command does

The CLI will:

- detect local session roots for `pi`, `codex`, and `claude`
- read supported history files
- validate normalized records with `Zod`
- keep only the labels you requested
- write one final parquet file
- write a manifest and a run log

## Default source behavior

- `pi`
  - full agent traces
  - can produce `cot_eligible` or `agent_only`
- `codex`
  - full agent traces
  - usually produces `agent_only`
- `claude`
  - prompt history only for now
  - produces `prompt_only`

Claude is intentionally low-fidelity right now. It is not treated as a full assistant/tool trace source.

## Default output

Each run creates one directory:

```text
<output-root>/agentic-dataset-<timestamp>/
  dataset.parquet
  manifest.json
  run.log
```

Files:

- `dataset.parquet`
  - final merged dataset
- `manifest.json`
  - source roots, source counts, labels kept, output path
- `run.log`
  - step-by-step execution log for debugging

## Recommended commands

Pi + Codex:

```bash
node dist/cli.js --output-root ./out --include-sources pi,codex --include-labels cot_eligible,agent_only
```

Codex + Claude prompt-only:

```bash
node dist/cli.js --output-root ./out --include-sources codex,claude --include-labels agent_only,prompt_only
```

Pi only:

```bash
node dist/cli.js --output-root ./out --include-sources pi --include-labels cot_eligible,agent_only
```

## Important flags

- `--output-root <dir>`
  - required output root
- `--include-sources <csv>`
  - any of: `pi,codex,claude`
- `--include-labels <csv>`
  - any of: `cot_eligible,agent_only,prompt_only,discard`
- `--pi-root <dir>`
  - override detected Pi session path
- `--codex-root <dir>`
  - override detected Codex session path
- `--claude-root <dir>`
  - override detected Claude project-history path
- `--help`
  - print CLI help

## Auto-detected paths

The CLI tries OS-specific defaults automatically.

Typical paths:

- Pi: `~/.pi/agent/sessions`
- Codex: `~/.codex/sessions`
- Claude: `~/.claude/projects`

On Windows it also checks `APPDATA` and `LOCALAPPDATA` variants.

## Verification checklist

After a run, verify these three things:

1. `dataset.parquet` exists
2. `manifest.json` exists
3. `run.log` does not end with an uncaught error

Typical quick check:

```bash
ls ./out/agentic-dataset-*/
```

## Development notes

Useful development commands:

```bash
npm run check
npm run test
npm run build
```

This repo currently includes:

- Zod validation for source events and final records
- Vitest coverage for core schema and labeling paths
- native parquet writing in TypeScript
