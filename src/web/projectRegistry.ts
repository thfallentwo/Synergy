import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProjectMeta } from '../core/types';
import { guessMime } from './staticAssets';

export interface ProjectSourceMeta {
  name: string;
  size: number;
  mime: string;
  uploadedAt: number;
}

export function samePath(a: string, b: string): boolean {
  const pa = path.resolve(a);
  const pb = path.resolve(b);
  return process.platform === 'win32' ? pa.toLowerCase() === pb.toLowerCase() : pa === pb;
}

export function defaultProjectsFilePath(): string {
  return path.join(process.env.AGORA_HOME || path.join(os.homedir(), '.agora'), 'projects.json');
}

export function isTempTestProjectDir(dir: string): boolean {
  const norm = path.resolve(dir).toLowerCase();
  const tmp = path.resolve(os.tmpdir()).toLowerCase();
  return (norm === tmp || norm.startsWith(tmp + path.sep)) && /[\\/]synergy-[a-z0-9]{4,}(?:[\\/]|$)/i.test(norm);
}

export function sourcesDirPath(root: string): string {
  return path.join(root, '.synergy', 'sources');
}

export function sourcesIndexPath(root: string): string {
  return path.join(root, '.synergy', 'sources.json');
}

export function readProjectSources(root: string): ProjectSourceMeta[] {
  try {
    const raw = fs.readFileSync(sourcesIndexPath(root), 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as ProjectSourceMeta[]) : [];
  } catch {
    return [];
  }
}

export function saveProjectSources(root: string, items: ProjectSourceMeta[]): ProjectSourceMeta[] {
  const clean = items.slice(0, 100);
  fs.mkdirSync(sourcesDirPath(root), { recursive: true });
  fs.writeFileSync(sourcesIndexPath(root), JSON.stringify(clean, null, 2), 'utf8');
  return clean;
}

export function addProjectSources(
  root: string,
  files: Array<{ name?: unknown; dataBase64?: unknown }>,
): ProjectSourceMeta[] {
  const dir = sourcesDirPath(root);
  fs.mkdirSync(dir, { recursive: true });
  const cur = readProjectSources(root);
  const now = Date.now();
  for (const f of files.slice(0, 50)) {
    if (!f || typeof f !== 'object') continue;
    const safe = path.basename(String(f.name ?? '')).replace(/[<>:"/\\|?*]/g, '_').trim();
    const b64 = String(f.dataBase64 ?? '');
    if (!safe || safe === '.' || safe === '..' || !b64) continue;
    const buf = Buffer.from(b64, 'base64');
    fs.writeFileSync(path.join(dir, safe), buf);
    const idx = cur.findIndex((x) => x.name === safe);
    const entry: ProjectSourceMeta = { name: safe, size: buf.length, mime: guessMime(safe), uploadedAt: now };
    if (idx >= 0) cur[idx] = entry;
    else cur.unshift(entry);
  }
  return saveProjectSources(root, cur);
}

export function removeProjectSource(root: string, name: string): ProjectSourceMeta[] {
  const safe = path.basename(name.trim());
  if (!safe) throw new Error('source name is empty');
  const fp = path.join(sourcesDirPath(root), safe);
  try {
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  } catch {
    /* ignore missing file */
  }
  const next = readProjectSources(root).filter((x) => x.name !== safe);
  return saveProjectSources(root, next);
}

export function readProjects(filePath: string, currentRoot?: string, stripTemp = false): ProjectMeta[] {
  let list: ProjectMeta[] = [];
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      for (const x of arr) {
        if (typeof x === 'string' && fs.existsSync(x)) {
          if (stripTemp && isTempTestProjectDir(x)) continue;
          list.push({ name: path.basename(x), dir: x, emoji: '🚀', color: '#ff8a3d' });
        } else if (x && typeof x === 'object' && typeof x.dir === 'string' && fs.existsSync(x.dir)) {
          if (stripTemp && isTempTestProjectDir(x.dir)) continue;
          list.push({
            name: String(x.name || path.basename(x.dir)),
            dir: x.dir,
            emoji: String(x.emoji || '🚀'),
            color: String(x.color || '#ff8a3d'),
            updatedAt: Number(x.updatedAt) || 0,
            archived: Boolean(x.archived),
            pinned: Boolean(x.pinned),
          });
        }
      }
    }
  } catch {
    list = [];
  }
  if (currentRoot && (!stripTemp || !isTempTestProjectDir(currentRoot)) && !list.some((p) => samePath(p.dir, currentRoot))) {
    list.unshift({ name: path.basename(currentRoot), dir: currentRoot, emoji: '🚀', color: '#ff8a3d' });
  }
  list.sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)));
  return list.slice(0, 100);
}

export function writeProjectsFile(filePath: string, list: ProjectMeta[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(list, null, 2), 'utf8');
}

export function upsertProjectMeta(filePath: string, meta: ProjectMeta, stripTemp = false): ProjectMeta[] {
  const existingList = readProjects(filePath, undefined, stripTemp);
  const prev = existingList.find((p) => samePath(p.dir, meta.dir));
  const remaining = existingList.filter((p) => !samePath(p.dir, meta.dir));
  const merged: ProjectMeta = {
    ...meta,
    pinned: meta.pinned ?? prev?.pinned ?? false,
    archived: meta.archived ?? prev?.archived ?? false,
    updatedAt: Date.now(),
  };
  const next = [merged, ...remaining]
    .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)))
    .slice(0, 100);
  try {
    writeProjectsFile(filePath, next);
  } catch {
    /* ignore write failures in read-only dirs */
  }
  return next;
}

export function listFolders(rawDir?: string): { dir: string; parent: string; folders: string[] } {
  let target = rawDir ? path.resolve(rawDir) : os.homedir();
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) target = os.homedir();
  const parent = path.dirname(target);
  const folders: string[] = [];
  try {
    for (const e of fs.readdirSync(target, { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith('.')) folders.push(e.name);
    }
  } catch {
    /* permission denied on some system dirs */
  }
  folders.sort((a, b) => a.localeCompare(b));
  return { dir: target, parent, folders: folders.slice(0, 200) };
}
