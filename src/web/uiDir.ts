import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Locate the shipped ui/ directory (works from src/ in tests and from dist/ when installed). */
export function findUiDir(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const cand = path.join(dir, 'ui');
    if (fs.existsSync(path.join(cand, 'index.html'))) return cand;
    dir = path.dirname(dir);
  }
  throw new Error('Synergy UI files (ui/index.html) not found');
}
