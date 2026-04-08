import fg from 'fast-glob';
import { Qwen35RecordSchema, type Qwen35Record } from '../schemas/qwen35.js';
import { CodexEntrySchema, type CodexEntry } from '../schemas/source.js';
import { readJsonl } from '../utils/jsonl.js';

class TurnBuilder {
  sessionMeta: Record<string, unknown>;
  turnId: string;
  startTs: string;
  messages: any[] = [];
  pendingText: string[] = [];
  pendingReasoning: string[] = [];
  pendingToolCalls: any[] = [];
  callNames = new Map<string, string>();
  tools = new Map<string, { name: string }>();
  lossyReasons = new Set<string>();
  lastTs: string;
  lastAgentMessage?: string;

  constructor(sessionMeta: Record<string, unknown>, turnId: string, startTs: string) {
    this.sessionMeta = sessionMeta;
    this.turnId = turnId;
    this.startTs = startTs;
    this.lastTs = startTs;
  }

  ingest(entry: CodexEntry) {
    this.lastTs = entry.timestamp ?? this.lastTs;
    const payload = (entry.payload ?? {}) as Record<string, unknown>;
    if (entry.type === 'response_item') this.ingestResponseItem(payload);
    if (entry.type === 'event_msg') this.ingestEvent(payload);
  }

  ingestResponseItem(payload: Record<string, unknown>) {
    const type = asString(payload.type);
    if (type === 'message') this.ingestMessage(payload);
    if (type === 'reasoning') this.ingestReasoning(payload);
    if (type === 'function_call') this.ingestFunctionCall(payload);
    if (type === 'function_call_output') this.ingestFunctionCallOutput(payload);
    if (type === 'custom_tool_call') this.ingestCustomToolCall(payload);
    if (type === 'custom_tool_call_output') this.ingestCustomToolCallOutput(payload);
  }

  ingestEvent(payload: Record<string, unknown>) {
    const type = asString(payload.type);
    if (type === 'exec_command_end') this.ingestExecCommandEnd(payload);
    if (type === 'task_complete') {
      const msg = asString(payload.last_agent_message);
      if (msg) this.lastAgentMessage = msg;
    }
    if (type === 'error' && asString(payload.message)) this.lossyReasons.add('turn_error');
  }

  ingestMessage(payload: Record<string, unknown>) {
    const role = asString(payload.role);
    const content = Array.isArray(payload.content) ? payload.content : [];
    const text = extractCodexText(content as Record<string, unknown>[]);
    if (role === 'assistant') {
      if (text) this.pendingText.push(text);
      return;
    }
    this.flushAssistant();
    if (role === 'user') this.messages.push({ role: 'user', content: text });
    else if (role === 'developer' && text) {
      const seenNonSystem = this.messages.some((message) => message.role !== 'system');
      if (seenNonSystem) {
        this.lossyReasons.add('late_developer_message_demoted');
        this.messages.push({ role: 'assistant', content: `[developer]\n${text}` });
      } else {
        this.messages.push({ role: 'system', content: text });
      }
    }
  }

  ingestReasoning(payload: Record<string, unknown>) {
    const summary = Array.isArray(payload.summary) ? payload.summary : [];
    const visible = summary
      .map((item) => (item && typeof item === 'object' ? asString((item as Record<string, unknown>).text) ?? asString((item as Record<string, unknown>).summary_text) : undefined))
      .filter(Boolean) as string[];
    const content = asString(payload.content);
    if (content) visible.push(content);
    if (visible.length) this.pendingReasoning.push(...visible);
    else if (payload.encrypted_content) this.lossyReasons.add('encrypted_reasoning_without_summary');
  }

  ingestFunctionCall(payload: Record<string, unknown>) {
    const name = asString(payload.name) ?? 'tool';
    const callId = asString(payload.call_id);
    const args = parseJsonObject(payload.arguments);
    this.pendingToolCalls.push({ type: 'function', id: callId, function: { name, arguments: args } });
    if (callId) this.callNames.set(callId, name);
    this.tools.set(name, { name });
  }

  ingestCustomToolCall(payload: Record<string, unknown>) {
    const name = asString(payload.name) ?? 'custom_tool';
    const callId = asString(payload.call_id);
    this.pendingToolCalls.push({
      type: 'function',
      id: callId,
      function: { name, arguments: { input: payload.input, status: payload.status } },
    });
    if (callId) this.callNames.set(callId, name);
    this.tools.set(name, { name });
  }

  ingestFunctionCallOutput(payload: Record<string, unknown>) {
    this.flushAssistant();
    const callId = asString(payload.call_id);
    const name = callId ? this.callNames.get(callId) ?? 'tool' : 'tool';
    const output = typeof payload.output === 'string' ? payload.output : JSON.stringify(payload.output);
    this.messages.push({ role: 'tool', name, tool_call_id: callId, content: output });
    this.tools.set(name, { name });
  }

  ingestCustomToolCallOutput(payload: Record<string, unknown>) {
    this.ingestFunctionCallOutput(payload);
  }

  ingestExecCommandEnd(payload: Record<string, unknown>) {
    this.flushAssistant();
    const callId = asString(payload.call_id);
    const name = callId ? this.callNames.get(callId) ?? 'exec_command' : 'exec_command';
    this.tools.set(name, { name });
    this.messages.push({
      role: 'tool',
      name,
      tool_call_id: callId,
      content: JSON.stringify({
        command: payload.command,
        cwd: payload.cwd,
        aggregated_output: payload.aggregated_output,
        exit_code: payload.exit_code,
        status: payload.status,
        duration: payload.duration,
      }),
    });
  }

  flushAssistant() {
    if (!this.pendingText.length && !this.pendingReasoning.length && !this.pendingToolCalls.length) return;
    const message: any = { role: 'assistant', content: this.pendingText.join('\n\n') };
    if (this.pendingReasoning.length) message.reasoning_content = this.pendingReasoning.join('\n\n');
    if (this.pendingToolCalls.length) message.tool_calls = [...this.pendingToolCalls];
    this.messages.push(message);
    this.pendingText = [];
    this.pendingReasoning = [];
    this.pendingToolCalls = [];
  }

  finalize(): Qwen35Record | null {
    if (this.lastAgentMessage && !this.pendingText.length) {
      this.pendingText.push(this.lastAgentMessage);
      this.lossyReasons.add('synthetic_last_agent_message');
    }
    this.flushAssistant();
    if (!this.messages.some((message) => message.role === 'user')) return null;
    return Qwen35RecordSchema.parse({
      id: `${asString(this.sessionMeta.id) ?? 'codex'}:${this.turnId}`,
      request_id: this.turnId,
      messages: this.messages,
      tools: [...this.tools.values()],
      meta: {
        endpoint: 'codex/turn',
        status: this.lossyReasons.has('turn_error') ? 500 : 200,
        ts: this.lastTs,
        key: asString(this.sessionMeta.id),
        source: `codex:session=${asString(this.sessionMeta.id)}:turn=${this.turnId}:cwd=${asString(this.sessionMeta.cwd)}`,
        requested_model: asString(this.sessionMeta.model),
        actual_model: asString(this.sessionMeta.model),
        stream: false,
        thinking_level: asString(this.sessionMeta.reasoning_effort),
        reasoning_summary_mode: 'codex_reasoning_summary',
        thinking_type: 'codex_turn',
        tool_spec_count: this.tools.size,
        tool_choice: { mode: 'session_trace' },
        request_contains_non_text_content: false,
        request_image_block_count: 0,
        request_video_block_count: 0,
        request_tool_call_block_count: 0,
        request_tool_result_block_count: 0,
        request_thinking_block_count: 0,
        response_contains_non_text_content: false,
        response_image_block_count: 0,
        response_video_block_count: 0,
        response_tool_call_block_count: this.messages.filter((m) => m.role === 'assistant').reduce((sum, m) => sum + ((m.tool_calls as unknown[])?.length ?? 0), 0),
        response_tool_result_block_count: this.messages.filter((m) => m.role === 'tool').length,
        response_thinking_block_count: this.messages.filter((m) => m.role === 'assistant' && typeof m.reasoning_content === 'string' && m.reasoning_content.length > 0).length,
        request_truncated: false,
        response_truncated: false,
        lossy_source: this.lossyReasons.size > 0,
        lossy_reasons: [...this.lossyReasons],
      },
    });
  }
}

export async function collectCodexRecords(root: string): Promise<Qwen35Record[]> {
  const files = await fg('**/*.jsonl', { cwd: root, absolute: true, onlyFiles: true });
  const records: Qwen35Record[] = [];
  for (const file of files.sort()) {
    const entries = (await readJsonl(file)).map((entry) => CodexEntrySchema.parse(entry));
    const sessionMeta = ((entries.find((entry) => entry.type === 'session_meta')?.payload ?? {}) as Record<string, unknown>);
    let builder: TurnBuilder | null = null;
    for (const entry of entries) {
      const payload = (entry.payload ?? {}) as Record<string, unknown>;
      if (entry.type === 'turn_context') {
        sessionMeta.model = payload.model;
        sessionMeta.reasoning_effort = payload.effort;
      }
      if (entry.type === 'event_msg' && payload.type === 'task_started') {
        builder = new TurnBuilder(sessionMeta, asString(payload.turn_id) ?? entry.timestamp ?? 'turn', entry.timestamp ?? '');
        continue;
      }
      if (!builder) continue;
      builder.ingest(entry);
      if (entry.type === 'event_msg' && payload.type === 'task_complete') {
        const record = builder.finalize();
        if (record) records.push(record);
        builder = null;
      }
    }
  }
  return records;
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { value: parsed };
  } catch {
    return { raw: value };
  }
}

function extractCodexText(content: Record<string, unknown>[]): string {
  return content
    .map((item) => {
      const type = asString(item.type);
      if ((type === 'input_text' || type === 'output_text') && typeof item.text === 'string') return item.text;
      if (type === 'input_image') return '[image]';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
