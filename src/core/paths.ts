import fs from 'node:fs';
import path from 'node:path';

export const SYNERGY_DIR = '.synergy';

/** Make a file path project-relative, POSIX-style, and refuse anything outside the root. */
export function normalizeFile(root: string, file: string): string {
  let f = file.trim().replace(/\\/g, '/');
  if (!f) throw new Error('file is empty');
  const rootPosix = path.resolve(root).replace(/\\/g, '/').replace(/\/+$/, '');
  if (f.startsWith('/') || /^[a-zA-Z]:\//.test(f)) {
    const fResolved = path.resolve(f).replace(/\\/g, '/');
    const cmp = (s: string) => (process.platform === 'win32' ? s.toLowerCase() : s);
    if (cmp(fResolved).startsWith(cmp(rootPosix) + '/')) f = fResolved.slice(rootPosix.length + 1);
    else throw new Error('file is outside the project root');
  }
  const norm = path.posix.normalize(f).replace(/^(\.\/)+/, '');
  if (norm === '..' || norm.startsWith('../')) throw new Error('file is outside the project root');
  if (norm === '.' || norm === '') throw new Error('file is empty');
  return norm.replace(/\/+$/, '');
}

/** Walk upwards from `start` looking for an existing .synergy directory. */
export function findRoot(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, SYNERGY_DIR))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Resolve the project root: explicit --root, SYNERGY_DIR env, nearest .synergy, else cwd. */
export function resolveRoot(opts: { root?: string; cwd?: string } = {}): string {
  if (opts.root) return path.resolve(opts.root);
  if (process.env.SYNERGY_DIR) return path.resolve(process.env.SYNERGY_DIR);
  const cwd = opts.cwd ?? process.cwd();
  return findRoot(cwd) ?? path.resolve(cwd);
}

/**
 * Like resolveRoot, but never guesses: without --root / SYNERGY_DIR it needs an existing .synergy/
 * above the working directory. Prevents stray databases when a client starts us from $HOME or `/`.
 */
export function requireRoot(opts: { root?: string; cwd?: string } = {}): string {
  if (opts.root) return path.resolve(opts.root);
  if (process.env.SYNERGY_DIR) return path.resolve(process.env.SYNERGY_DIR);
  const found = findRoot(opts.cwd ?? process.cwd());
  if (!found) {
    throw new Error('No .synergy/ directory found. Run `npx synergy-mcp init` in your project, or pass --root <dir>.');
  }
  return found;
}

export function dbPath(root: string): string {
  return path.join(root, SYNERGY_DIR, 'synergy.db');
}
