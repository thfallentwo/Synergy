import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface GitStatusInfo {
  isRepo: boolean;
  branch: string;
  remote: string;
  changes: number;
  files: string[];
  userName: string;
  userEmail: string;
  hasGithubAuth: boolean;
  githubUser: string;
  authSource: 'gh' | 'token' | 'env' | 'ssh' | 'none';
}

interface StoredGitHubAuth {
  token?: string;
  userName?: string;
  userEmail?: string;
}

function githubAuthPath(): string {
  return path.join(process.env.AGORA_HOME || path.join(os.homedir(), '.agora'), 'github.json');
}

function readStoredGitHubAuth(): StoredGitHubAuth {
  try {
    const raw = fs.readFileSync(githubAuthPath(), 'utf8');
    const p = JSON.parse(raw);
    return p && typeof p === 'object' ? (p as StoredGitHubAuth) : {};
  } catch {
    return {};
  }
}

export function saveGitHubAuth(input: { token?: string; userName?: string; userEmail?: string }): StoredGitHubAuth {
  const cur = readStoredGitHubAuth();
  const next: StoredGitHubAuth = {
    token: input.token !== undefined ? input.token.trim() || undefined : cur.token,
    userName: input.userName !== undefined ? input.userName.trim().slice(0, 80) || undefined : cur.userName,
    userEmail: input.userEmail !== undefined ? input.userEmail.trim().slice(0, 120) || undefined : cur.userEmail,
  };
  const fp = githubAuthPath();
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

export function clearGitHubAuth(): void {
  try {
    const fp = githubAuthPath();
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  } catch {
    /* ignore */
  }
}

function runGit(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function detectGitHubAuth(
  remote: string,
  stored: StoredGitHubAuth,
): { hasGithubAuth: boolean; githubUser: string; authSource: GitStatusInfo['authSource'] } {
  if (stored.token) {
    return { hasGithubAuth: true, githubUser: stored.userName || 'GitHub Token', authSource: 'token' };
  }
  const envTok = process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim();
  if (envTok) {
    return { hasGithubAuth: true, githubUser: 'ENV Token', authSource: 'env' };
  }
  try {
    const out = execFileSync('gh', ['auth', 'status'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 1500,
    });
    const m = /Logged in to github\.com account ([^\s(]+)/i.exec(out);
    return { hasGithubAuth: true, githubUser: m?.[1] || 'GitHub CLI', authSource: 'gh' };
  } catch {
    /* gh not installed or not logged in */
  }
  if (/^(git@github\.com:|ssh:\/\/git@github\.com)/i.test(remote)) {
    const sshDir = path.join(os.homedir(), '.ssh');
    if (fs.existsSync(path.join(sshDir, 'id_ed25519')) || fs.existsSync(path.join(sshDir, 'id_rsa'))) {
      return { hasGithubAuth: true, githubUser: 'SSH Key', authSource: 'ssh' };
    }
  }
  return { hasGithubAuth: false, githubUser: '', authSource: 'none' };
}

/** Inspect repository status, active branch, remote origin URL, dirty files, and real GitHub auth state. */
export function getGitStatus(root: string): GitStatusInfo {
  const stored = readStoredGitHubAuth();
  let userName = stored.userName || '';
  let userEmail = stored.userEmail || '';
  try {
    const cfgName = runGit(root, ['config', 'user.name']);
    if (cfgName) userName = cfgName;
  } catch { /* ignore */ }
  try {
    const cfgEmail = runGit(root, ['config', 'user.email']);
    if (cfgEmail) userEmail = cfgEmail;
  } catch { /* ignore */ }

  let isRepo = false;
  try {
    isRepo = runGit(root, ['rev-parse', '--is-inside-work-tree']) === 'true';
  } catch {
    isRepo = false;
  }
  if (!isRepo) {
    const auth = detectGitHubAuth('', stored);
    return { isRepo: false, branch: '', remote: '', changes: 0, files: [], userName, userEmail, ...auth };
  }

  let branch = '';
  try {
    branch = runGit(root, ['branch', '--show-current']) || 'main';
  } catch {
    branch = 'main';
  }

  let remote = '';
  try {
    remote = runGit(root, ['remote', 'get-url', 'origin']);
  } catch {
    remote = '';
  }

  let files: string[] = [];
  try {
    const porcelain = runGit(root, ['status', '--porcelain']);
    files = porcelain
      ? porcelain
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean)
          .slice(0, 50)
      : [];
  } catch {
    files = [];
  }

  const auth = detectGitHubAuth(remote, stored);
  return { isRepo: true, branch, remote, changes: files.length, files, userName, userEmail, ...auth };
}

/** Initialize git if needed and configure the `origin` remote URL (e.g. GitHub repo). */
export function setGitRemote(root: string, rawUrl: string): GitStatusInfo {
  const url = rawUrl.trim();
  if (!/^(https:\/\/|git@|ssh:\/\/)\S+$/i.test(url)) {
    throw new Error('Enter a valid GitHub URL (https://github.com/... or git@github.com:...)');
  }
  const st = getGitStatus(root);
  if (!st.isRepo) {
    runGit(root, ['init']);
  }
  try {
    runGit(root, ['remote', 'set-url', 'origin', url]);
  } catch {
    runGit(root, ['remote', 'add', 'origin', url]);
  }
  return getGitStatus(root);
}

/** Stage all changes, create a commit, and optionally push to `origin` (requiring real GitHub auth). */
export function commitAndPush(
  root: string,
  rawMessage: string,
  push = false,
): { ok: true; hash: string; pushed: boolean; output: string } {
  const message = rawMessage.trim().slice(0, 140);
  if (!message) throw new Error('commit message is empty');

  const st = getGitStatus(root);
  if (push) {
    if (!st.remote) throw new Error('Önce bir GitHub repo URL bağlayın.');
    if (!st.hasGithubAuth) throw new Error('GitHub hesabına giriş yapılmamış. Önce GitHub hesabını bağlayın.');
  }

  if (!st.isRepo) runGit(root, ['init']);

  runGit(root, ['add', '-A']);
  const dirty = runGit(root, ['status', '--porcelain']);
  if (!dirty) throw new Error('no changes to commit');

  const commitArgs: string[] = [];
  const stored = readStoredGitHubAuth();
  if (!st.userName && stored.userName) commitArgs.push('-c', `user.name=${stored.userName}`);
  if (!st.userEmail && stored.userEmail) commitArgs.push('-c', `user.email=${stored.userEmail}`);
  commitArgs.push('commit', '-m', message);
  const commitOut = runGit(root, commitArgs);
  const hash = runGit(root, ['rev-parse', '--short', 'HEAD']);

  let pushOut = '';
  let pushed = false;
  if (push) {
    const branch = runGit(root, ['branch', '--show-current']) || 'main';
    const pushArgs: string[] = [];
    if (stored.token && /^https:\/\/github\.com\//i.test(st.remote)) {
      const b64 = Buffer.from(`x-access-token:${stored.token}`, 'utf8').toString('base64');
      pushArgs.push('-c', `http.https://github.com/.extraheader=AUTHORIZATION: basic ${b64}`);
    }
    pushArgs.push('push', '-u', 'origin', branch);
    pushOut = runGit(root, pushArgs);
    pushed = true;
  }

  return { ok: true, hash, pushed, output: [commitOut, pushOut].filter(Boolean).join('\n') };
}
