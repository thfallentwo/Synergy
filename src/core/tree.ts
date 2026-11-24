import fs from 'node:fs';
import path from 'node:path';

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', '__pycache__', 'venv', 'target']);

/** Flat, sorted, POSIX-style list of project files for the explorer (capped, no dot-directories). */
export function listProjectFiles(root: string, maxFiles = 3000, maxDepth = 8): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string, depth: number) => {
    if (out.length >= maxFiles || depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= maxFiles) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
        walk(path.join(dir, e.name), r, depth + 1);
      } else if (e.isFile()) {
        out.push(r);
      }
    }
  };
  walk(root, '', 0);
  return out;
}
