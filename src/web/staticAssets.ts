import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

export function guessMime(name: string): string {
  const ext = path.extname(name).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.js' || ext === '.mjs') return 'application/javascript; charset=utf-8';
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.txt' || ext === '.md' || ext === '.ts' || ext === '.lua') return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

function sendFile(res: http.ServerResponse, filePath: string, contentType: string, cacheControl: string): boolean {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return false;
  res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': cacheControl });
  res.end(fs.readFileSync(filePath));
  return true;
}

function resolveInside(baseDir: string, relSegments: string[]): string | null {
  const baseResolved = path.resolve(baseDir);
  const target = path.resolve(baseResolved, ...relSegments);
  const cmp = (v: string) => (process.platform === 'win32' ? v.toLowerCase() : v);
  if (!cmp(target).startsWith(cmp(baseResolved) + path.sep)) return null;
  return target;
}

/**
 * Serve static frontend modules, icons, uploaded images, and project sources.
 * Returns true if the response was handled (including 404 on invalid asset path).
 */
export function tryServeStaticAsset(
  reqPath: string,
  res: http.ServerResponse,
  uiDir: string,
  projectRoot: string,
): boolean {
  if (reqPath.startsWith('/icons/')) {
    const m = /^\/icons\/([a-z0-9-]+\.png)$/.exec(reqPath);
    if (!m) return sendNotFound(res);
    const file = resolveInside(path.join(uiDir, 'icons'), [m[1]]);
    if (!file || !sendFile(res, file, 'image/png', 'public, max-age=3600')) return sendNotFound(res);
    return true;
  }

  if (reqPath.startsWith('/styles/')) {
    const m = /^\/styles\/([a-z0-9._-]+\.css)$/i.exec(reqPath);
    if (!m) return sendNotFound(res);
    const file = resolveInside(path.join(uiDir, 'styles'), [m[1]]);
    if (!file || !sendFile(res, file, 'text/css; charset=utf-8', 'no-store')) return sendNotFound(res);
    return true;
  }

  if (reqPath.startsWith('/app/')) {
    const rel = reqPath.slice('/app/'.length);
    if (!/^[a-z0-9/_-]+\.js$/i.test(rel) || rel.includes('..')) return sendNotFound(res);
    const file = resolveInside(path.join(uiDir, 'app'), rel.split('/'));
    if (!file || !sendFile(res, file, 'application/javascript; charset=utf-8', 'no-store')) return sendNotFound(res);
    return true;
  }

  const upMatch = /^\/uploads\/([a-z0-9-]+\.(png|jpg|jpeg|webp|gif))$/i.exec(reqPath);
  if (upMatch) {
    const file = resolveInside(path.join(projectRoot, '.synergy', 'uploads'), [upMatch[1]]);
    const ext = upMatch[2].toLowerCase();
    const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
    if (!file || !sendFile(res, file, mime, 'public, max-age=3600')) return sendNotFound(res);
    return true;
  }

  const srcMatch = /^\/sources\/([^/]+)$/.exec(reqPath);
  if (srcMatch) {
    const safe = path.basename(decodeURIComponent(srcMatch[1]));
    const file = resolveInside(path.join(projectRoot, '.synergy', 'sources'), [safe]);
    if (!file || !sendFile(res, file, guessMime(safe), 'public, max-age=3600')) return sendNotFound(res);
    return true;
  }

  return false;
}

function sendNotFound(res: http.ServerResponse): boolean {
  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ error: 'not found' }));
  return true;
}
