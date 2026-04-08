import fs from 'node:fs';
import fg from 'fast-glob';
import { Qwen35RecordSchema, type Qwen35Record } from '../schemas/qwen35.js';
import { PiSessionEntrySchema, PiSessionHeaderSchema, type PiSessionEntry } from '../schemas/source.js';
import { isFile } from '../utils/common.js';
import { readJsonl } from '../utils/jsonl.js';

export async function collectPiRecords(root: string): Promise<Qwen35Record[]> {
  const files = await fg('**/*.jsonl', { cwd: root, absolute: true, onlyFiles: true });
  const records: Qwen35Record[] = [];
  for (const file of files.sort()) {
    const rawRows = await readJsonl(file);
    const rows = rawRows.map((row, index) => (index === 0 ? PiSessionHeaderSchema.parse(row) : PiSessionEntrySchema.parse(row)));
    if (!rows.length) continue;
    const header = rows[0] as Record<string, unknown>;
    const body = rows.slice(1);
    const byId = new Map<string, PiSessionEntry>();
    const children = new Map<string | null, string[]>();
    for (const entry of body) {
      if (!entry.id) continue;
      byId.set(entry.id, entry);
      const key = typeof entry.parentId === 'string' ? entry.parentId : null;
      const bucket = children.get(key) ?? [];
      bucket.push(entry.id);
      children.set(key, bucket);
    }
    const leaves = [...byId.keys()].filter((id) => !children.get(id)?.length).sort();
    for (const leaf of leaves) {
      const pathEntries = branchEntries(leaf, byId);
      const record = buildPiRecord(pathEntries, header, file, leaves.length > 1);
      records.push(Qwen35RecordSchema.parse(record));
    }
  }
  return records;
}

function branchEntries(leaf: string, byId: Map<string, PiSessionEntry>): PiSessionEntry[] {
  const ordered: PiSessionEntry[] = [];
  let current: string | null = leaf;
  while (current) {
    const entry = byId.get(current);
    if (!entry) break;
    ordered.push(entry);
    current = typeof entry.parentId === 'string' ? entry.parentId : null;
  }
  return ordered.reverse();
}

function buildPiRecord(entries: PiSessionEntry[], header: Record<string, unknown>, sourceFile: string, branched: boolean): Qwen35Record {
  const messages: any[] = [];
  const tools = new Map<string, { name: string }>();
  const lossyReasons = new Set<string>();
  const models: string[] = [];
  const thinkingLevels: string[] = [];

  for (const entry of entries) {
    if (entry.type === 'model_change') {
      const provider = asString((entry as Record<string, unknown>).provider);
      const modelId = asString((entry as Record<string, unknown>).modelId);
      if (modelId) models.push(provider ? `${provider}/${modelId}` : modelId);
      continue;
    }
    if (entry.type === 'thinking_level_change') {
      const level = asString((entry as Record<string, unknown>).thinkingLevel);
      if (level) thinkingLevels.push(level);
      continue;
    }
    if (entry.type === 'message') {
      const msg = (entry as Record<string, unknown>).message as Record<string, unknown> | undefined;
      if (!msg) continue;
      const role = asString(msg.role);
      if (role === 'user') {
        messages.push({ role: 'user', content: normalizeContent(msg.content, lossyReasons, 'user') });
      } else if (role === 'assistant') {
        messages.push(normalizeAssistant(msg, tools, lossyReasons));
      } else if (role === 'toolResult') {
        const toolName = asString(msg.toolName) ?? 'tool';
        tools.set(toolName, { name: toolName });
        messages.push({
          role: 'tool',
          name: toolName,
          tool_call_id: asString(msg.toolCallId),
          content: normalizeContent(msg.content, lossyReasons, 'tool_result'),
        });
      } else if (role === 'bashExecution') {
        tools.set('bash', { name: 'bash' });
        messages.push({ role: 'tool', name: 'bash', content: formatBash(msg, lossyReasons) });
      }
      continue;
    }
    if (entry.type === 'branch_summary') {
      const summary = asString((entry as Record<string, unknown>).summary);
      if (summary) {
        lossyReasons.add('synthetic_branch_summary');
        messages.push({ role: 'assistant', content: `[branch_summary]\n${summary}` });
      }
      continue;
    }
    if (entry.type === 'compaction') {
      const summary = asString((entry as Record<string, unknown>).summary);
      if (summary) {
        lossyReasons.add('synthetic_compaction_summary');
        messages.push({ role: 'assistant', content: `[compaction_summary]\n${summary}` });
      }
    }
  }

  if (branched) lossyReasons.add('session_tree_branch_selected');
  if (new Set(models).size > 1) lossyReasons.add('multiple_models_on_branch');
  if (new Set(thinkingLevels).size > 1) lossyReasons.add('multiple_thinking_levels_on_branch');

  const meta = buildMeta(messages, {
    endpoint: 'pi/session_branch',
    ts: asString(entries.at(-1)?.timestamp) ?? asString(header.timestamp) ?? '',
    key: asString(header.id) ?? undefined,
    source: `${sourceFile}#leaf=${entries.at(-1)?.id ?? ''}`,
    requested_model: models[0] ?? undefined,
    actual_model: models.at(-1) ?? undefined,
    thinking_level: thinkingLevels.at(-1) ?? undefined,
    tool_spec_count: tools.size,
    tool_choice: { mode: 'session_trace' },
    reasoning_summary_mode: 'pi_session_branch',
    thinking_type: 'pi_session',
    lossy_reasons: [...lossyReasons],
  });

  return {
    id: `${asString(header.id) ?? 'pi'}:${entries.at(-1)?.id ?? 'leaf'}`,
    request_id: asString(header.id) ?? undefined,
    messages,
    tools: [...tools.values()],
    meta,
  } as any;
}

function normalizeAssistant(msg: Record<string, unknown>, tools: Map<string, { name: string }>, lossyReasons: Set<string>) {
  const content = msg.content;
  const textBlocks: Array<{ type: 'text'; text: string }> = [];
  const reasoning: string[] = [];
  const toolCalls: Array<Record<string, unknown>> = [];
  if (Array.isArray(content)) {
    for (const raw of content) {
      if (!raw || typeof raw !== 'object') continue;
      const block = raw as Record<string, unknown>;
      const type = asString(block.type);
      if (type === 'text') {
        textBlocks.push({ type: 'text', text: asString(block.text) ?? '' });
      } else if (type === 'thinking') {
        const rawThinking = asString(block.thinking);
        const thinking = sanitizePiThinking(rawThinking);
        if (thinking) reasoning.push(thinking);
        if (!thinking && asString(block.thinkingSignature)) lossyReasons.add('encrypted_reasoning_without_visible_text');
      } else if (type === 'toolCall') {
        const name = asString(block.name) ?? 'tool';
        tools.set(name, { name });
        toolCalls.push({
          type: 'function',
          id: asString(block.id),
          function: {
            name,
            arguments: isRecord(block.arguments) ? block.arguments : {},
          },
        });
      }
    }
  }
  const assistant: Record<string, unknown> = {
    role: 'assistant',
    content: textBlocks.length === 1 ? textBlocks[0].text : textBlocks,
  };
  if (reasoning.length) assistant.reasoning_content = reasoning.join('\n\n');
  if (toolCalls.length) assistant.tool_calls = toolCalls;
  return assistant;
}

function sanitizePiThinking(value: string | undefined): string | undefined {
  if (!value) return undefined;
  // Strip only a true outer wrapper while preserving literal inner `<think>` text.
  const cleaned = value.replace(/^\s*<think>\s*/i, '').replace(/\s*<\/think>\s*$/i, '').trim();
  return cleaned || undefined;
}

function formatBash(msg: Record<string, unknown>, lossyReasons: Set<string>): string {
  const truncated = Boolean(msg.truncated);
  let output = asString(msg.output) ?? '';
  const fullOutputPath = asString(msg.fullOutputPath) ?? asString((msg.details as Record<string, unknown> | undefined)?.fullOutputPath);
  if (truncated && fullOutputPath) {
    if (isFile(fullOutputPath)) {
      output = fs.readFileSync(fullOutputPath, 'utf8');
    } else {
      lossyReasons.add('missing_embedded_full_output');
    }
  }
  return JSON.stringify({
    command: asString(msg.command),
    exit_code: asNumber(msg.exitCode),
    cancelled: Boolean(msg.cancelled),
    truncated,
    exclude_from_context: Boolean(msg.excludeFromContext),
    output,
  });
}

function normalizeContent(content: unknown, lossyReasons: Set<string>, prefix: string): unknown {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) {
    lossyReasons.add(`${prefix}_nonstandard_content`);
    return JSON.stringify(content);
  }
  const blocks: Array<Record<string, unknown>> = [];
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue;
    const block = raw as Record<string, unknown>;
    const type = asString(block.type);
    if (type === 'text') blocks.push({ type: 'text', text: asString(block.text) ?? '' });
  }
  if (blocks.length === 1) return blocks[0].text;
  return blocks;
}

function buildMeta(messages: any[], seed: Record<string, any>) {
  const assistantMessages = messages.filter((m) => m.role === 'assistant');
  const toolMessages = messages.filter((m) => m.role === 'tool');
  return {
    endpoint: seed.endpoint,
    status: 200,
    ts: seed.ts,
    key: seed.key,
    source: seed.source,
    requested_model: seed.requested_model,
    actual_model: seed.actual_model,
    stream: false,
    thinking_level: seed.thinking_level,
    reasoning_summary_mode: seed.reasoning_summary_mode,
    thinking_type: seed.thinking_type,
    thinking_budget_tokens: undefined,
    max_output_tokens: undefined,
    tool_spec_count: seed.tool_spec_count,
    tool_choice: seed.tool_choice,
    request_contains_non_text_content: false,
    request_image_block_count: 0,
    request_video_block_count: 0,
    request_tool_call_block_count: 0,
    request_tool_result_block_count: 0,
    request_thinking_block_count: 0,
    response_contains_non_text_content: false,
    response_image_block_count: 0,
    response_video_block_count: 0,
    response_tool_call_block_count: assistantMessages.reduce((sum, msg) => sum + ((msg.tool_calls as unknown[])?.length ?? 0), 0),
    response_tool_result_block_count: toolMessages.length,
    response_thinking_block_count: assistantMessages.filter((msg) => typeof msg.reasoning_content === 'string' && msg.reasoning_content.length > 0).length,
    request_truncated: false,
    response_truncated: Array.isArray(seed.lossy_reasons) ? seed.lossy_reasons.includes('missing_embedded_full_output') : false,
    lossy_source: (seed.lossy_reasons as string[]).length > 0,
    lossy_reasons: seed.lossy_reasons,
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
