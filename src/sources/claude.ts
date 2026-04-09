import fg from 'fast-glob';
import { Qwen35RecordSchema, type Qwen35Record } from '../schemas/qwen35.js';
import { ClaudeProjectEntrySchema } from '../schemas/source.js';
import { readJsonl } from '../utils/jsonl.js';

interface ClaudeTurnBuilder {
  cwd?: string;
  entrypoint?: string;
  file: string;
  invalidJsonlLineSkipped: boolean;
  lastTs: string;
  messages: Qwen35Record['messages'];
  pendingText: string[];
  pendingReasoning: string[];
  pendingToolCalls: Array<{ type: 'function'; id?: string; function: { name: string; arguments: Record<string, unknown> } }>;
  requestIds: string[];
  sessionId?: string;
  toolNames: Set<string>;
  lossyReasons: Set<string>;
  models: string[];
}

export async function collectClaudePromptOnlyRecords(root: string): Promise<Qwen35Record[]> {
  return collectClaudeRecords(root);
}

export async function collectClaudeRecords(root: string): Promise<Qwen35Record[]> {
  const files = await fg('**/*.jsonl', { cwd: root, absolute: true, onlyFiles: true });
  const records: Qwen35Record[] = [];

  for (const file of files.sort()) {
    let invalidJsonlLineSkipped = false;
    const entries = (await readJsonl(file, {
      skipInvalid: true,
      onInvalidLine: () => {
        invalidJsonlLineSkipped = true;
      },
    })).map((row) => ClaudeProjectEntrySchema.parse(row));

    let current: ClaudeTurnBuilder | undefined;
    for (const entry of entries) {
      const next = ingestClaudeEntry(current, entry, file, invalidJsonlLineSkipped, records);
      current = next.current;
      invalidJsonlLineSkipped = next.invalidJsonlLineSkipped;
    }
    if (current) flushClaudeTurn(current, records);
  }

  return records;
}

function ingestClaudeEntry(
  current: ClaudeTurnBuilder | undefined,
  entry: Record<string, unknown>,
  file: string,
  invalidJsonlLineSkipped: boolean,
  records: Qwen35Record[],
): { current: ClaudeTurnBuilder | undefined; invalidJsonlLineSkipped: boolean } {
  const type = asString(entry.type);

  if (type === 'assistant') {
    const turn = current ?? createTurn(file, entry, invalidJsonlLineSkipped);
    ingestAssistant(turn, entry);
    return { current: turn, invalidJsonlLineSkipped: false };
  }

  if (type === 'user') {
    if (isToolResultEntry(entry)) {
      const turn = current ?? createTurn(file, entry, invalidJsonlLineSkipped);
      ingestToolResult(turn, entry);
      return { current: turn, invalidJsonlLineSkipped: false };
    }

    if (shouldIgnoreUserEntry(entry)) {
      if (current && invalidJsonlLineSkipped) current.lossyReasons.add('invalid_jsonl_line_skipped');
      return { current, invalidJsonlLineSkipped };
    }

    if (current) flushClaudeTurn(current, records);
    const turn = createTurn(file, entry, invalidJsonlLineSkipped);
    ingestUser(turn, entry);
    return { current: turn, invalidJsonlLineSkipped: false };
  }

  if (type === 'system' && current) {
    ingestSystem(current, entry);
    if (invalidJsonlLineSkipped) current.lossyReasons.add('invalid_jsonl_line_skipped');
    return { current, invalidJsonlLineSkipped: false };
  }

  if (invalidJsonlLineSkipped && current) {
    current.lossyReasons.add('invalid_jsonl_line_skipped');
    return { current, invalidJsonlLineSkipped: false };
  }

  return { current, invalidJsonlLineSkipped };
}

function createTurn(file: string, entry: Record<string, unknown>, invalidJsonlLineSkipped: boolean): ClaudeTurnBuilder {
  const turn: ClaudeTurnBuilder = {
    cwd: asString(entry.cwd),
    entrypoint: asString(entry.entrypoint),
    file,
    invalidJsonlLineSkipped,
    lastTs: asString(entry.timestamp) ?? '',
    messages: [],
    pendingText: [],
    pendingReasoning: [],
    pendingToolCalls: [],
    requestIds: [],
    sessionId: asString(entry.sessionId),
    toolNames: new Set<string>(),
    lossyReasons: new Set<string>(),
    models: [],
  };
  if (invalidJsonlLineSkipped) turn.lossyReasons.add('invalid_jsonl_line_skipped');
  return turn;
}

function ingestUser(turn: ClaudeTurnBuilder, entry: Record<string, unknown>) {
  flushAssistant(turn);
  turn.lastTs = asString(entry.timestamp) ?? turn.lastTs;
  turn.sessionId ??= asString(entry.sessionId);
  turn.cwd ??= asString(entry.cwd);
  turn.entrypoint ??= asString(entry.entrypoint);
  const requestId = asString(entry.promptId) ?? asString(entry.uuid);
  if (requestId) turn.requestIds.push(requestId);

  const message = isRecord(entry.message) ? entry.message : {};
  const content = normalizeUserContent(message.content, turn.lossyReasons);
  if (content === undefined) {
    turn.lossyReasons.add('empty_user_message');
    return;
  }
  turn.messages.push({ role: 'user', content });
}

function ingestAssistant(turn: ClaudeTurnBuilder, entry: Record<string, unknown>) {
  turn.lastTs = asString(entry.timestamp) ?? turn.lastTs;
  turn.sessionId ??= asString(entry.sessionId);
  turn.cwd ??= asString(entry.cwd);
  turn.entrypoint ??= asString(entry.entrypoint);

  const message = isRecord(entry.message) ? entry.message : {};
  const model = asString(message.model);
  if (model) turn.models.push(model);

  const content = Array.isArray(message.content) ? message.content : [];
  for (const rawBlock of content) {
    if (!isRecord(rawBlock)) continue;
    const blockType = asString(rawBlock.type);
    if (blockType === 'text') {
      const text = asString(rawBlock.text);
      if (text) turn.pendingText.push(text);
      continue;
    }
    if (blockType === 'thinking') {
      const thinking = asString(rawBlock.thinking) ?? asString(rawBlock.text);
      if (thinking) turn.pendingReasoning.push(thinking);
      else if (asString(rawBlock.signature)) turn.lossyReasons.add('encrypted_reasoning_without_visible_text');
      continue;
    }
    if (blockType === 'tool_use') {
      const name = asString(rawBlock.name) ?? 'tool';
      const toolCall = {
        type: 'function' as const,
        id: asString(rawBlock.id),
        function: {
          name,
          arguments: isRecord(rawBlock.input) ? rawBlock.input : {},
        },
      };
      turn.pendingToolCalls.push(toolCall);
      turn.toolNames.add(name);
      continue;
    }
    turn.lossyReasons.add(`assistant_block_${blockType ?? 'unknown'}_ignored`);
  }
}

function ingestToolResult(turn: ClaudeTurnBuilder, entry: Record<string, unknown>) {
  flushAssistant(turn);
  turn.lastTs = asString(entry.timestamp) ?? turn.lastTs;
  const message = isRecord(entry.message) ? entry.message : {};
  const content = Array.isArray(message.content) ? message.content : [];
  let added = false;

  for (const rawBlock of content) {
    if (!isRecord(rawBlock) || asString(rawBlock.type) !== 'tool_result') continue;
    const toolCallId = asString(rawBlock.tool_use_id);
    const payload = isRecord(entry.toolUseResult) ? entry.toolUseResult : undefined;
    const name = inferToolName(payload) ?? inferToolNameFromCall(turn, toolCallId) ?? 'tool';
    turn.toolNames.add(name);
    turn.messages.push({
      role: 'tool',
      name,
      tool_call_id: toolCallId,
      content: normalizeToolResultContent(rawBlock, payload),
    });
    added = true;
  }

  if (!added) {
    turn.lossyReasons.add('tool_result_without_block');
  }
}

function ingestSystem(turn: ClaudeTurnBuilder, entry: Record<string, unknown>) {
  const subtype = asString(entry.subtype);
  if (subtype === 'api_error') turn.lossyReasons.add('api_error_retry');
  else if (subtype === 'compact_boundary') turn.lossyReasons.add('compact_boundary');
  else if (subtype === 'microcompact_boundary') turn.lossyReasons.add('microcompact_boundary');
}

function flushAssistant(turn: ClaudeTurnBuilder) {
  if (!turn.pendingText.length && !turn.pendingReasoning.length && !turn.pendingToolCalls.length) return;
  const content = normalizeTextParts(turn.pendingText);
  const assistant: Qwen35Record['messages'][number] = {
    role: 'assistant',
    content,
  } as Qwen35Record['messages'][number];
  if (turn.pendingReasoning.length) {
    (assistant as Extract<Qwen35Record['messages'][number], { role: 'assistant' }>).reasoning_content = turn.pendingReasoning.join('\n\n');
  }
  if (turn.pendingToolCalls.length) {
    (assistant as Extract<Qwen35Record['messages'][number], { role: 'assistant' }>).tool_calls = [...turn.pendingToolCalls];
  }
  turn.messages.push(assistant);
  turn.pendingText = [];
  turn.pendingReasoning = [];
  turn.pendingToolCalls = [];
}

function flushClaudeTurn(turn: ClaudeTurnBuilder, records: Qwen35Record[]) {
  flushAssistant(turn);
  if (!turn.messages.some((message) => message.role === 'user')) return;

  const tools = [...turn.toolNames].sort().map((name) => ({ name }));
  const requestId = turn.requestIds[0];
  const actualModel = turn.models.at(-1);
  const meta = buildClaudeMeta(turn, tools.length, actualModel);
  const record = Qwen35RecordSchema.parse({
    id: `${turn.sessionId ?? turn.file}:${requestId ?? (turn.lastTs || 'turn')}`,
    request_id: requestId,
    messages: turn.messages,
    tools,
    meta,
  });
  records.push(record);
}

function buildClaudeMeta(turn: ClaudeTurnBuilder, toolSpecCount: number, actualModel: string | undefined) {
  const assistantMessages = turn.messages.filter((message) => message.role === 'assistant');
  const toolMessages = turn.messages.filter((message) => message.role === 'tool');
  const userMessages = turn.messages.filter((message) => message.role === 'user');
  const requestBlockCounts = countContentBlocks(userMessages.map((message) => message.content));

  return {
    endpoint: 'claude/project_trace',
    status: 200,
    ts: turn.lastTs,
    key: turn.sessionId,
    source: `claude:session=${turn.sessionId}:cwd=${turn.cwd}:entrypoint=${turn.entrypoint}:file=${turn.file}`,
    requested_model: actualModel,
    actual_model: actualModel,
    stream: false,
    thinking_level: undefined,
    reasoning_summary_mode: 'claude_project_trace',
    thinking_type: assistantMessages.some((message) => typeof message.reasoning_content === 'string' && message.reasoning_content.length > 0)
      ? 'visible_reasoning'
      : undefined,
    tool_spec_count: toolSpecCount,
    tool_choice: toolSpecCount ? { mode: 'session_trace' } : { mode: 'none' },
    request_contains_non_text_content: requestBlockCounts.containsNonText,
    request_image_block_count: requestBlockCounts.image,
    request_video_block_count: requestBlockCounts.video,
    request_tool_call_block_count: 0,
    request_tool_result_block_count: 0,
    request_thinking_block_count: 0,
    response_contains_non_text_content: toolMessages.length > 0,
    response_image_block_count: 0,
    response_video_block_count: 0,
    response_tool_call_block_count: assistantMessages.reduce((sum, message) => sum + (message.tool_calls?.length ?? 0), 0),
    response_tool_result_block_count: toolMessages.length,
    response_thinking_block_count: assistantMessages.filter((message) => typeof message.reasoning_content === 'string' && message.reasoning_content.length > 0).length,
    request_truncated: false,
    response_truncated: false,
    lossy_source: turn.lossyReasons.size > 0,
    lossy_reasons: [...turn.lossyReasons].sort(),
  };
}

function normalizeUserContent(content: unknown, lossyReasons: Set<string>): Qwen35Record['messages'][number]['content'] | undefined {
  if (typeof content === 'string') {
    const trimmed = content.trim();
    return trimmed ? trimmed : undefined;
  }
  if (!Array.isArray(content)) {
    lossyReasons.add('user_nonstandard_content');
    return JSON.stringify(content);
  }

  const blocks: Array<{ type: 'text'; text: string }> = [];
  for (const rawBlock of content) {
    if (!isRecord(rawBlock)) continue;
    const blockType = asString(rawBlock.type);
    if (blockType === 'text') {
      const text = asString(rawBlock.text);
      if (text) blocks.push({ type: 'text', text });
      continue;
    }
    if (blockType === 'tool_result') continue;
    lossyReasons.add(`user_block_${blockType ?? 'unknown'}_ignored`);
  }
  return normalizeTextParts(blocks.map((block) => block.text));
}

function normalizeToolResultContent(block: Record<string, unknown>, payload?: Record<string, unknown>) {
  const direct = asString(block.content);
  if (direct) return direct;

  if (payload) {
    const file = isRecord(payload.file) ? payload.file : undefined;
    if (typeof payload.stdout === 'string' || typeof payload.stderr === 'string') {
      return JSON.stringify({
        stdout: asString(payload.stdout) ?? '',
        stderr: asString(payload.stderr) ?? '',
        interrupted: Boolean(payload.interrupted),
        isImage: Boolean(payload.isImage),
        noOutputExpected: Boolean(payload.noOutputExpected),
      });
    }
    if (file) {
      return JSON.stringify({
        filePath: asString(file.filePath),
        content: asString(file.content),
        numLines: asNumber(file.numLines),
        startLine: asNumber(file.startLine),
        totalLines: asNumber(file.totalLines),
      });
    }
    if (typeof payload.content === 'string') return payload.content;
    return JSON.stringify(payload);
  }

  return '';
}

function countContentBlocks(contents: unknown[]) {
  let image = 0;
  let video = 0;
  let containsNonText = false;

  for (const content of contents) {
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === 'image') {
        image += 1;
        containsNonText = true;
      }
      if (block.type === 'video') {
        video += 1;
        containsNonText = true;
      }
    }
  }

  return { image, video, containsNonText };
}

function isToolResultEntry(entry: Record<string, unknown>): boolean {
  const message = isRecord(entry.message) ? entry.message : {};
  const content = message.content;
  return Array.isArray(content) && content.some((block) => isRecord(block) && asString(block.type) === 'tool_result');
}

function shouldIgnoreUserEntry(entry: Record<string, unknown>): boolean {
  if (entry.isMeta === true) return true;
  const message = isRecord(entry.message) ? entry.message : {};
  const content = message.content;
  if (typeof content !== 'string') return false;
  const trimmed = content.trim();
  if (!trimmed) return true;
  return trimmed === '[Request interrupted by user]'
    || trimmed.includes('<local-command-caveat>')
    || trimmed.includes('<local-command-stdout>')
    || trimmed.includes('<command-name>');
}

function inferToolName(payload: Record<string, unknown> | undefined): string | undefined {
  if (!payload) return undefined;
  const keys = ['toolName', 'tool_name', 'name'];
  for (const key of keys) {
    const value = asString(payload[key]);
    if (value) return value;
  }
  if (payload.filePath || payload.structuredPatch || payload.originalFile !== undefined) return 'Write';
  if (payload.stdout !== undefined || payload.stderr !== undefined || payload.interrupted !== undefined) return 'Bash';
  if (payload.oldTodos || payload.newTodos) return 'TodoWrite';
  if (isRecord(payload.file) || payload.type === 'text') return 'Read';
  return undefined;
}

function inferToolNameFromCall(turn: ClaudeTurnBuilder, toolCallId: string | undefined): string | undefined {
  if (!toolCallId) return undefined;
  for (const message of [...turn.messages].reverse()) {
    if (message.role !== 'assistant') continue;
    const match = message.tool_calls?.find((call) => call.id === toolCallId);
    if (match) return match.function.name;
  }
  for (const pending of turn.pendingToolCalls) {
    if (pending.id === toolCallId) return pending.function.name;
  }
  return undefined;
}

function normalizeTextParts(parts: string[]): Qwen35Record['messages'][number]['content'] {
  const filtered = parts.map((part) => part.trim()).filter(Boolean);
  if (!filtered.length) return '';
  if (filtered.length === 1) return filtered[0]!;
  return filtered.map((text) => ({ type: 'text' as const, text }));
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
