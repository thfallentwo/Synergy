import { describe, expect, it } from 'vitest';
import { parseAntigravityLines, parseClaudeLines } from '../src/core/liveObserver';

describe('LiveObserver parsers', () => {
  it('parses Antigravity working steps and auto-collapses when final content arrives', () => {
    const workingLines = [
      JSON.stringify({
        step_index: 1,
        type: 'USER_INPUT',
        created_at: '2026-11-25T17:00:00Z',
        content: 'Fix auth.ts',
      }),
      JSON.stringify({
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-25T17:00:03Z',
        model: 'gemini-4-neon-high',
        input_tokens: 1200,
        output_tokens: 180,
        tool_calls: [
          { name: 'update_focus', args: { focus: '"Inspecting auth.ts"' } },
          { name: 'read_file', args: { Path: '"C:\\\\proj\\\\src\\\\auth.ts"' } },
          {
            name: 'edit_file',
            args: {
              Path: '"C:\\\\proj\\\\src\\\\auth.ts"',
              Target: '"const a = 1;"',
              Replacement: '"const a = 1;\\nconst b = 2;"',
            },
          },
          { name: 'run_command', args: { CommandLine: '"npm test"', toolSummary: '"Run unit tests"' } },
        ],
      }),
    ];

    const working = parseAntigravityLines(workingLines);
    expect(working).toHaveLength(1);
    expect(working[0].status).toBe('working');
    expect(working[0].agent).toBe('antigravity');
    expect(working[0].steps.map((s) => s.kind)).toEqual(['focus', 'read', 'edit', 'cmd']);
    expect(working[0].steps[2]).toMatchObject({ added: 2, removed: 1, label: 'edited auth.ts; +2 -1' });

    const doneLines = [
      ...workingLines,
      JSON.stringify({
        step_index: 3,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-25T17:00:15Z',
        model: 'gemini-4-neon-high',
        input_tokens: 500,
        output_tokens: 90,
        content: 'Kurdum, çalışıyor.',
        tool_calls: [],
      }),
    ];

    const done = parseAntigravityLines(doneLines);
    expect(done).toHaveLength(1);
    expect(done[0].status).toBe('done');
    expect(done[0].finalText).toBe('Kurdum, çalışıyor.');
    expect(done[0].tokensIn).toBe(1700);
    expect(done[0].tokensOut).toBe(270);
  });

  it('parses Claude Code JSONL turns with Read, Edit, Bash, and final text', () => {
    const lines = [
      JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-11-25T17:10:00Z', message: { content: 'Check app.py' } }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2026-11-25T17:10:02Z',
        message: {
          model: 'claude-sonnet-5-5',
          usage: { input_tokens: 900, output_tokens: 140 },
          content: [
            { type: 'tool_use', name: 'Read', input: { file_path: '/repo/app.py' } },
            { type: 'tool_use', name: 'Edit', input: { file_path: '/repo/app.py', old_string: 'x = 1', new_string: 'x = 2\ny = 3' } },
          ],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'a2',
        timestamp: '2026-11-25T17:10:08Z',
        message: {
          model: 'claude-sonnet-5-5',
          usage: { input_tokens: 200, output_tokens: 60 },
          content: [{ type: 'text', text: 'Updated app.py cleanly.' }],
        },
      }),
    ];

    const turns = parseClaudeLines(lines);
    expect(turns).toHaveLength(1);
    expect(turns[0].status).toBe('done');
    expect(turns[0].agent).toBe('claude-code');
    expect(turns[0].steps).toHaveLength(2);
    expect(turns[0].steps[1]).toMatchObject({ added: 2, removed: 1, label: 'edited app.py; +2 -1' });
    expect(turns[0].finalText).toBe('Updated app.py cleanly.');
  });
});
