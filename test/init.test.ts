import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { init } from '../src/cli/init';
import { tmpRoot } from './helpers';

afterEach(() => vi.restoreAllMocks());

describe('synergy init', () => {
  it('creates .synergy and SYNERGY_RULES.md, is idempotent, never clobbers rules', () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const root = tmpRoot();
    init({ root });
    expect(fs.existsSync(path.join(root, '.synergy', 'synergy.db'))).toBe(true);
    expect(fs.readFileSync(path.join(root, '.synergy', '.gitignore'), 'utf8')).toBe('*\n');
    const rules = path.join(root, 'SYNERGY_RULES.md');
    expect(fs.readFileSync(rules, 'utf8')).toContain('lock_file');
    fs.writeFileSync(rules, 'custom');
    init({ root });
    expect(fs.readFileSync(rules, 'utf8')).toBe('custom');
    init({ root, force: true });
    expect(fs.readFileSync(rules, 'utf8')).toContain('SYNERGY RULES');
  });

  it('--link-rules appends once to existing agent files only; --write merges .cursor/mcp.json', () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# mine\n');
    fs.mkdirSync(path.join(root, '.cursor'));
    fs.writeFileSync(path.join(root, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
    init({ root, linkRules: true, write: true });
    init({ root, linkRules: true, write: true });
    const claude = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
    expect(claude.match(/SYNERGY_RULES\.md/g)).toHaveLength(1);
    expect(fs.existsSync(path.join(root, 'AGENTS.md'))).toBe(false);
    const mcp = JSON.parse(fs.readFileSync(path.join(root, '.cursor', 'mcp.json'), 'utf8'));
    expect(Object.keys(mcp.mcpServers).sort()).toEqual(['other', 'synergy']);
    expect(mcp.mcpServers.synergy.env.SYNERGY_AGENT).toBe('cursor');
  });
});
