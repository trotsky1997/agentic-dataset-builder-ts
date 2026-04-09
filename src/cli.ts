#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { candidateClaudeRoots, candidateCodexRoots, candidatePiRoots, firstExisting } from './platform/paths.js';
import { collectPiRecords } from './sources/pi.js';
import { collectCodexRecords } from './sources/codex.js';
import { collectClaudeRecords } from './sources/claude.js';
import { labelRecord } from './labeling.js';
import { Qwen35RecordSchema, type Qwen35Record } from './schemas/qwen35.js';
import { writeParquet } from './parquet.js';

interface Args {
  outputRoot: string;
  includeSources: string[];
  includeLabels: Set<string>;
  piRoot?: string;
  codexRoot?: string;
  claudeRoot?: string;
}

function parseArgs(argv: string[]): Args {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`agentic-dataset-builder@0.2.4

Usage:
  npx agentic-dataset-builder@0.2.4 --output-root ./out

Options:
  --output-root <dir>       Output directory root
  --include-sources <list>  Comma-separated: pi,codex,claude
  --include-labels <list>   Comma-separated: cot_eligible,agent_only,prompt_only,discard
  --pi-root <dir>           Override Pi session root
  --codex-root <dir>        Override Codex session root
  --claude-root <dir>       Override Claude project history root
  --help                    Show this help message
`);
    process.exit(0);
  }

  const args: Args = {
    outputRoot: './out',
    includeSources: ['pi', 'codex'],
    includeLabels: new Set(['cot_eligible', 'agent_only']),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--output-root' && next) {
      args.outputRoot = next;
      i += 1;
    } else if (arg === '--include-sources' && next) {
      args.includeSources = next.split(',').map((v) => v.trim()).filter(Boolean);
      i += 1;
    } else if (arg === '--include-labels' && next) {
      args.includeLabels = new Set(next.split(',').map((v) => v.trim()).filter(Boolean));
      i += 1;
    } else if (arg === '--pi-root' && next) {
      args.piRoot = next;
      i += 1;
    } else if (arg === '--codex-root' && next) {
      args.codexRoot = next;
      i += 1;
    } else if (arg === '--claude-root' && next) {
      args.claudeRoot = next;
      i += 1;
    }
  }
  return args;
}

function stampDir(base: string): string {
  const iso = new Date().toISOString().replace(/[:.]/g, '-');
  return path.resolve(base, `agentic-dataset-${iso}`);
}

function createLogger(runDir: string) {
  const logPath = path.join(runDir, 'run.log');
  fs.writeFileSync(logPath, '', 'utf8');
  return {
    logPath,
    log(step: string, message: string) {
      const line = `[${step}] ${message}`;
      console.log(line);
      fs.appendFileSync(logPath, `${line}\n`, 'utf8');
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runDir = stampDir(args.outputRoot);
  fs.mkdirSync(runDir, { recursive: true });
  const logger = createLogger(runDir);

  const allRecords: Qwen35Record[] = [];
  const sourceStats: Record<string, Record<string, number>> = {};

  for (const source of args.includeSources) {
    if (source === 'pi') {
      const root = path.resolve(args.piRoot ?? firstExisting(candidatePiRoots()));
      logger.log('pi', `reading ${root}`);
      const records = await collectPiRecords(root);
      sourceStats.pi = { records: records.length };
      for (const record of records) pushLabeled(record, 'pi', args.includeLabels, allRecords);
      logger.log('pi', `kept ${allRecords.filter((r) => r.source_system === 'pi').length} labeled records`);
    }
    if (source === 'codex') {
      const root = path.resolve(args.codexRoot ?? firstExisting(candidateCodexRoots()));
      logger.log('codex', `reading ${root}`);
      const records = await collectCodexRecords(root);
      sourceStats.codex = { records: records.length };
      for (const record of records) pushLabeled(record, 'codex', args.includeLabels, allRecords);
      logger.log('codex', `kept ${allRecords.filter((r) => r.source_system === 'codex').length} labeled records`);
    }
    if (source === 'claude') {
      const root = path.resolve(args.claudeRoot ?? firstExisting(candidateClaudeRoots()));
      logger.log('claude', `reading ${root}`);
      const records = await collectClaudeRecords(root);
      sourceStats.claude = { records: records.length };
      for (const record of records) pushLabeled(record, 'claude', args.includeLabels, allRecords);
      logger.log('claude', `kept ${allRecords.filter((r) => r.source_system === 'claude').length} labeled records`);
    }
  }

  const datasetPath = path.join(runDir, 'dataset.parquet');
  logger.log('write', `writing ${allRecords.length} records to ${datasetPath}`);
  await writeParquet(datasetPath, allRecords);
  const manifest = {
    runDir,
    datasetParquetPath: datasetPath,
    recordCount: allRecords.length,
    includeSources: args.includeSources,
    includeLabels: [...args.includeLabels],
    sourceStats,
    runLog: logger.logPath,
  };
  fs.writeFileSync(path.join(runDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(manifest));
}

function pushLabeled(record: Qwen35Record, sourceSystem: string, includeLabels: Set<string>, target: Qwen35Record[]) {
  const info = labelRecord(record);
  if (!includeLabels.has(info.label)) return;
  const enriched = Qwen35RecordSchema.parse({
    ...record,
    label: info.label,
    source_system: sourceSystem,
    source_bucket: record.meta.lossy_source ? 'lossy' : 'strict',
    source_file: record.meta.source,
    agentic_label: {
      label: info.label,
      tool_call_count: info.toolCallCount,
      tool_message_count: info.toolMessageCount,
      dialogue_rounds_est: info.dialogueRounds,
      reasoning_chars: info.reasoningChars,
      has_reasoning: info.hasReasoning,
      lossy_source: record.meta.lossy_source,
      lossy_reasons: info.lossyReasons,
    },
    meta: {
      ...record.meta,
      dataset_label: info.label,
      dataset_source_system: sourceSystem,
      dataset_source_bucket: record.meta.lossy_source ? 'lossy' : 'strict',
      dataset_source_file: record.meta.source,
      dataset_has_reasoning: info.hasReasoning,
      dataset_reasoning_chars: info.reasoningChars,
    },
  });
  target.push(enriched);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
