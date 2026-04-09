import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectClaudeRecords } from './claude.js';

describe('collectClaudeRecords', () => {
  it('extracts Claude assistant turns with tool calls and reasoning', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-history-'));
    const file = path.join(dir, 'sample.jsonl');
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ type: 'user', sessionId: 's1', promptId: 'p1', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'create hello world' } }),
        JSON.stringify({
          type: 'assistant',
          sessionId: 's1',
          timestamp: '2026-01-01T00:00:01Z',
          message: { role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'thinking', thinking: 'Need to write a file.' }] },
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId: 's1',
          timestamp: '2026-01-01T00:00:02Z',
          message: { role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'text', text: 'I will create the file now.' }] },
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId: 's1',
          timestamp: '2026-01-01T00:00:03Z',
          message: { role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'tool_use', id: 'call-1', name: 'Write', input: { file_path: '/tmp/hello.py', content: 'print("Hello")\n' } }] },
        }),
        JSON.stringify({
          type: 'user',
          sessionId: 's1',
          timestamp: '2026-01-01T00:00:04Z',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'File created successfully' }] },
          toolUseResult: { type: 'create', filePath: '/tmp/hello.py', content: 'print("Hello")\n' },
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId: 's1',
          timestamp: '2026-01-01T00:00:05Z',
          message: { role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'text', text: 'Done.' }] },
        }),
        JSON.stringify({ type: 'system', sessionId: 's1', timestamp: '2026-01-01T00:00:06Z', subtype: 'stop_hook_summary' }),
      ].join('\n') + '\n',
      'utf8',
    );

    const records = await collectClaudeRecords(dir);
    expect(records).toHaveLength(1);
    expect(records[0].meta.actual_model).toBe('claude-sonnet-4-6');
    expect(records[0].meta.lossy_reasons).toEqual([]);
    expect(records[0].messages).toEqual([
      { role: 'user', content: 'create hello world' },
      {
        role: 'assistant',
        content: 'I will create the file now.',
        reasoning_content: 'Need to write a file.',
        tool_calls: [{ type: 'function', id: 'call-1', function: { name: 'Write', arguments: { file_path: '/tmp/hello.py', content: 'print("Hello")\n' } } }],
      },
      { role: 'tool', name: 'Write', tool_call_id: 'call-1', content: 'File created successfully' },
      { role: 'assistant', content: 'Done.' },
    ]);
  });

  it('skips Claude local command meta prompts', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-history-'));
    const file = path.join(dir, 'sample.jsonl');
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ type: 'user', sessionId: 's1', promptId: 'p1', timestamp: '2026-01-01T00:00:00Z', isMeta: true, message: { role: 'user', content: '<local-command-caveat>ignore</local-command-caveat>' } }),
        JSON.stringify({ type: 'user', sessionId: 's1', promptId: 'p2', timestamp: '2026-01-01T00:00:01Z', message: { role: 'user', content: 'real prompt' } }),
      ].join('\n') + '\n',
      'utf8',
    );

    const records = await collectClaudeRecords(dir);
    expect(records).toHaveLength(1);
    expect(records[0].messages).toEqual([{ role: 'user', content: 'real prompt' }]);
  });
});
