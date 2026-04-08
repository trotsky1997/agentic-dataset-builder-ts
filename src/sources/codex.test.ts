import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectCodexRecords } from './codex.js';

describe('collectCodexRecords', () => {
  it('demotes late developer messages instead of emitting invalid system ordering', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-history-'));
    const file = path.join(dir, 'sample.jsonl');
    const rows = [
      { type: 'session_meta', payload: { id: 's1', cwd: '/tmp' } },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' }, timestamp: '2026-01-01T00:00:00Z' },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }, timestamp: '2026-01-01T00:00:01Z' },
      { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'extra constraint' }] }, timestamp: '2026-01-01T00:00:02Z' },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }, timestamp: '2026-01-01T00:00:03Z' },
      { type: 'event_msg', payload: { type: 'task_complete' }, timestamp: '2026-01-01T00:00:04Z' },
    ];
    fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');

    const records = await collectCodexRecords(dir);
    expect(records).toHaveLength(1);
    expect(records[0].meta.lossy_reasons).toContain('late_developer_message_demoted');
    expect(records[0].messages[1]?.role).toBe('assistant');
  });
});
