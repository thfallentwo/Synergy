import fs from 'node:fs';
import path from 'node:path';
import type { Synergy } from '../core/service';

const AUTH = `export interface User {
  id: string;
  name: string;
  email: string;
}

export function canEdit(user: User): boolean {
  return Boolean(user.id);
}

export function hashPassword(pw: string): string {
  // TODO: replace with argon2
  return Buffer.from(pw).toString('base64');
}
`;

const SESSION = `const sessions = new Map<string, { userId: string; at: number }>();

export function createSession(userId: string): string {
  const id = Math.random().toString(36).slice(2);
  sessions.set(id, { userId, at: Date.now() });
  return id;
}

export function getSession(id: string) {
  return sessions.get(id);
}
`;

const USER = `import type { User } from '../auth';

const users: User[] = [];

export function findUser(id: string): User | undefined {
  return users.find((u) => u.id === id);
}
`;

const dead = (n: number) =>
  Array.from({ length: n }, (_, i) => `function legacyHelper${i}(x: number) {\n  return x * ${i + 2} + ${i};\n}\n`).join('\n');
const BENCH = `export function hot(items: number[]) {\n  let sum = 0;\n  for (const i of items) sum += Math.sqrt(i);\n  return sum;\n}\n\n${dead(12)}`;

export const SEED: Record<string, string> = {
  'src/auth.ts': AUTH,
  'src/session.ts': SESSION,
  'src/db/user.ts': USER,
  'src/bench.ts': BENCH,
  'package.json': '{\n  "name": "demo-app",\n  "version": "1.0.0"\n}\n',
  'README.md': '# demo-app\n\nA tiny project used by the Synergy demo.\n',
};

const TXT: Record<string, Record<string, string>> = {
  role: { en: 'Added role field to User', tr: 'User tipine role alanı eklendi' },
  roleQ: { en: 'Is role optional for legacy users?', tr: 'Eski kullanıcılar için role isteğe bağlı mı?' },
  roleA: { en: 'No. Defaults to "member"; migration pending.', tr: 'Hayır. Varsayılan "member"; migrasyon bekliyor.' },
  ttl: { en: 'Added session TTL and cleanup', tr: 'Oturum TTL ve temizlik eklendi' },
  dead: { en: 'Removed dead helpers, tuned hot loop', tr: 'Ölü yardımcılar silindi, ana döngü hızlandırıldı' },
  argon: { en: 'Switched hashing to argon2 stub, added requireRole', tr: 'Hash argon2 taslağına geçti, requireRole eklendi' },
  tests: { en: 'Added auth role tests', tr: 'Auth role testleri eklendi' },
  user: { en: 'findUser now filters by role', tr: 'findUser artık role göre filtreliyor' },
  human: { en: 'finish auth.ts first, then run the tests', tr: 'önce auth.ts bitir, sonra testleri çalıştır' },
  wait: { en: 'Waiting for auth.ts lock', tr: 'auth.ts kilidi bekleniyor' },
};

const C = 'claude-code';
const U = 'cursor';
const G = 'gemini';
const A = 'antigravity';

export function seedProject(root: string): void {
  for (const [f, t] of Object.entries(SEED)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), t);
  }
  const tests = path.join(root, 'tests');
  fs.rmSync(tests, { recursive: true, force: true });
}

export function resetStore(svc: Synergy): void {
  for (const t of ['events', 'agents', 'locks', 'snapshots', 'diffs', 'sqlite_sequence']) svc.db.exec(`DELETE FROM ${t}`);
}

export interface DemoOptions {
  speed?: number;
  signal?: AbortSignal;
  loop?: boolean;
}

/** Scripted multi-agent session that goes through the same service API real MCP tools use. */
export async function runDemo(svc: Synergy, root: string, opts: DemoOptions = {}): Promise<void> {
  const speed = opts.speed ?? 1;
  const sig = opts.signal;
  const sleep = (ms: number) =>
    new Promise<void>((res) => {
      if (sig?.aborted) return res();
      const t = setTimeout(res, ms / speed);
      sig?.addEventListener('abort', () => (clearTimeout(t), res()), { once: true });
    });
  const t = (k: string) => TXT[k][svc.getLang()] ?? TXT[k].en;
  const abs = (f: string) => path.join(root, f);
  const edit = (f: string, fn: (s: string) => string) => fs.writeFileSync(abs(f), fn(fs.readFileSync(abs(f), 'utf8')));
  const post = (agent: string, action: string, file: string, key: string) =>
    svc.postStatus({ agent, action, file, summary: t(key) });

  do {
    seedProject(root);
    resetStore(svc);
    await sleep(1500);
    if (sig?.aborted) return;

    svc.readFeed({ agent: U });
    svc.readFeed({ agent: G });
    await sleep(900);

    svc.readFeed({ agent: C });
    svc.lockFile({ agent: C, file: 'src/auth.ts' });
    await sleep(2200);
    edit('src/auth.ts', (s) => s.replace('  email: string;\n}', '  email: string;\n  role: "admin" | "member";\n}').replace('return Boolean(user.id);', 'return user.role === "admin";'));
    post(C, 'MODIFIED', 'src/auth.ts', 'role');
    await sleep(1800);

    svc.lockFile({ agent: U, file: 'src/session.ts' });
    await sleep(1600);
    edit('src/session.ts', (s) => s + `\nconst TTL_MS = 30 * 60_000;\n\nexport function sweepSessions(now = Date.now()) {\n  for (const [id, s] of sessions) {\n    if (now - s.at > TTL_MS) sessions.delete(id);\n  }\n}\n`);
    post(U, 'MODIFIED', 'src/session.ts', 'ttl');
    await sleep(1700);

    svc.lockFile({ agent: G, file: 'src/auth.ts' }); // DENIED: claude-code holds it
    svc.postStatus({ agent: G, action: 'BLOCKED', file: 'src/auth.ts', summary: t('wait') });
    svc.askAgent({ from: G, to: C, question: t('roleQ') });
    await sleep(2200);
    const q = svc.recentEvents(10).filter((e) => e.type === 'ask').at(-1);
    svc.askAgent({ from: C, to: G, question: t('roleA'), replyTo: q?.id });
    await sleep(1800);

    svc.lockFile({ agent: A, file: 'src/bench.ts' });
    await sleep(1500);
    edit('src/bench.ts', (s) => s.split('\n\n').slice(0, 7).join('\n\n') + '\n');
    post(A, 'MODIFIED', 'src/bench.ts', 'dead');
    await sleep(1600);

    svc.humanSend(`@claude-code ${t('human')}`);
    await sleep(2200);

    edit('src/auth.ts', (s) => s.replace(/export function hashPassword[\s\S]*$/, `export function hashPassword(pw: string): string {\n  return "argon2$" + Buffer.from(pw).toString("base64");\n}\n\nexport function requireRole(user: User, role: User["role"]): void {\n  if (user.role !== role) throw new Error("forbidden");\n}\n`));
    post(C, 'MODIFIED', 'src/auth.ts', 'argon');
    await sleep(1200);
    svc.unlockFile({ agent: C, file: 'src/auth.ts' });
    await sleep(1400);

    svc.lockFile({ agent: G, file: 'tests/auth.test.ts' });
    fs.mkdirSync(abs('tests'), { recursive: true });
    fs.writeFileSync(abs('tests/auth.test.ts'), `import { describe, expect, it } from "vitest";\nimport { canEdit, requireRole } from "../src/auth";\n\nconst admin = { id: "1", name: "A", email: "a@x.io", role: "admin" as const };\nconst member = { ...admin, role: "member" as const };\n\ndescribe("auth roles", () => {\n  it("admins can edit", () => {\n    expect(canEdit(admin)).toBe(true);\n  });\n  it("members cannot edit", () => {\n    expect(canEdit(member)).toBe(false);\n  });\n  it("requireRole throws on mismatch", () => {\n    expect(() => requireRole(member, "admin")).toThrow("forbidden");\n  });\n});\n`);
    await sleep(1800);
    post(G, 'CREATED', 'tests/auth.test.ts', 'tests');
    await sleep(1400);
    svc.unlockFile({ agent: G, file: 'tests/auth.test.ts' });

    svc.unlockFile({ agent: U, file: 'src/session.ts' });
    svc.lockFile({ agent: U, file: 'src/db/user.ts' });
    await sleep(1400);
    edit('src/db/user.ts', (s) => s.replace('return users.find((u) => u.id === id);', 'return users.find((u) => u.id === id && u.role !== undefined);'));
    post(U, 'MODIFIED', 'src/db/user.ts', 'user');
    await sleep(1200);
    svc.unlockFile({ agent: U, file: 'src/db/user.ts' });
    svc.unlockFile({ agent: A, file: 'src/bench.ts' });
    await sleep(9000);
  } while (opts.loop && !sig?.aborted);
}
