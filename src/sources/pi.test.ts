import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectPiRecords } from './pi.js';

describe('collectPiRecords', () => {
  it('strips only outer think wrappers from Pi reasoning blocks', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-history-'));
    const file = path.join(dir, 'sample.jsonl');
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ type: 'session', version: 3, id: 's1', timestamp: '2026-01-01T00:00:00Z', cwd: '/tmp/project' }),
        JSON.stringify({ type: 'model_change', id: 'm1', parentId: null, timestamp: '2026-01-01T00:00:01Z', provider: 'test', modelId: 'model' }),
        JSON.stringify({ type: 'thinking_level_change', id: 't1', parentId: 'm1', timestamp: '2026-01-01T00:00:02Z', thinkingLevel: 'high' }),
        JSON.stringify({
          type: 'message',
          id: 'u1',
          parentId: 't1',
          timestamp: '2026-01-01T00:00:03Z',
          message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        }),
        JSON.stringify({
          type: 'message',
          id: 'a1',
          parentId: 'u1',
          timestamp: '2026-01-01T00:00:04Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: '<think>\nreasoning\n</think>' },
              { type: 'text', text: 'answer' },
            ],
          },
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    const records = await collectPiRecords(dir);
    expect(records).toHaveLength(1);
    if (records[0].messages[1]?.role !== 'assistant') throw new Error('expected assistant message');
    expect(records[0].messages[1].reasoning_content).toBe('reasoning');
  });

  it('preserves literal inner think text after outer wrapper removal', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-history-'));
    const file = path.join(dir, 'sample.jsonl');
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ type: 'session', version: 3, id: 's1', timestamp: '2026-01-01T00:00:00Z', cwd: '/tmp/project' }),
        JSON.stringify({ type: 'message', id: 'u1', parentId: null, timestamp: '2026-01-01T00:00:01Z', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } }),
        JSON.stringify({
          type: 'message',
          id: 'a1',
          parentId: 'u1',
          timestamp: '2026-01-01T00:00:02Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: '<think>Use `<think>` as literal XML tag in docs.</think>' },
            ],
          },
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    const records = await collectPiRecords(dir);
    if (records[0].messages[1]?.role !== 'assistant') throw new Error('expected assistant message');
    expect(records[0].messages[1].reasoning_content).toContain('`<think>`');
  });

  it('marks wrapped-empty reasoning with signature as lossy', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-history-'));
    const file = path.join(dir, 'sample.jsonl');
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ type: 'session', version: 3, id: 's1', timestamp: '2026-01-01T00:00:00Z', cwd: '/tmp/project' }),
        JSON.stringify({ type: 'message', id: 'u1', parentId: null, timestamp: '2026-01-01T00:00:01Z', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } }),
        JSON.stringify({
          type: 'message',
          id: 'a1',
          parentId: 'u1',
          timestamp: '2026-01-01T00:00:02Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: '<think>   </think>', thinkingSignature: '{"encrypted_content":"x"}' },
            ],
          },
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    const records = await collectPiRecords(dir);
    expect(records[0].meta.lossy_reasons).toContain('encrypted_reasoning_without_visible_text');
  });
});
