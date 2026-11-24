import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findRoot, normalizeFile } from '../src/core/paths';
import { tmpRoot } from './helpers';
import fs from 'node:fs';

describe('normalizeFile', () => {
  it('normalizes separators and ./', () => {
    expect(normalizeFile('/proj', './src\\auth.ts')).toBe('src/auth.ts');
    expect(normalizeFile('/proj', 'src//a/../b.ts')).toBe('src/b.ts');
  });
  it('makes absolute paths inside root relative', () => {
    expect(normalizeFile('/proj', '/proj/src/a.ts')).toBe('src/a.ts');
  });
  it('rejects paths outside root or empty', () => {
    expect(() => normalizeFile('/proj', '../x.ts')).toThrow(/outside/);
    expect(() => normalizeFile('/proj', '/etc/passwd')).toThrow(/outside/);
    expect(() => normalizeFile('/proj', '  ')).toThrow(/empty/);
    expect(() => normalizeFile('/proj', '.')).toThrow(/empty/);
  });
});

describe('findRoot', () => {
  it('finds .synergy walking upwards', () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, '.synergy'));
    const deep = path.join(root, 'a', 'b');
    fs.mkdirSync(deep, { recursive: true });
    expect(fs.realpathSync(findRoot(deep)!)).toBe(fs.realpathSync(root));
  });
});
