import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeAgent } from './agents';
import type { AgentPrefEntry, AgentPrefsMap, ApiKeyEntry, ProfileStats, SkillInfo } from './types';

export const API_KEY_PROVIDERS: ReadonlyArray<{ provider: string; label: string }> = [
  { provider: 'openai', label: 'OpenAI (ChatGPT / Codex)' },
  { provider: 'anthropic', label: 'Anthropic (Claude)' },
  { provider: 'gemini', label: 'Google Gemini' },
  { provider: 'deepseek', label: 'DeepSeek' },
  { provider: 'nemotron', label: 'NVIDIA Nemotron' },
  { provider: 'grok', label: 'xAI Grok' },
  { provider: 'kimi', label: 'Moonshot Kimi' },
  { provider: 'copilot', label: 'GitHub Copilot' },
  { provider: 'perplexity', label: 'Perplexity Sonar' },
];

function keysFile(root: string): string {
  return path.join(root, '.synergy', 'api-keys.json');
}

function readRawKeys(root: string): Record<string, string> {
  const file = keysFile(root);
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function maskKey(k: string): string {
  if (!k) return '';
  if (k.length <= 8) return '****';
  return `${k.slice(0, 4)}...${k.slice(-4)}`;
}

/** Return masked API key statuses for AIs that connect via API instead of MCP. */
export function apiKeyStatusList(root: string): ApiKeyEntry[] {
  const map = readRawKeys(root);
  return API_KEY_PROVIDERS.map(({ provider, label }) => {
    const val = (map[provider] ?? '').trim();
    return {
      provider,
      label,
      configured: val.length > 0,
      masked: val ? maskKey(val) : '',
    };
  });
}

/** Save or clear a provider API key inside `.synergy/api-keys.json`. */
export function saveProviderApiKey(root: string, providerRaw: string, apiKeyRaw: string): ApiKeyEntry[] {
  const provider = providerRaw.trim().toLowerCase();
  if (!API_KEY_PROVIDERS.some((p) => p.provider === provider)) {
    throw new Error('unsupported provider');
  }
  const map = readRawKeys(root);
  const val = apiKeyRaw.trim();
  if (val) map[provider] = val;
  else delete map[provider];
  const file = keysFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(map, null, 2), 'utf8');
  return apiKeyStatusList(root);
}

function parseFrontmatter(md: string): { name?: string; description?: string; agent?: string } {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const lines = m[1].split(/\r?\n/);
  let name = '';
  let description = '';
  let agent = '';
  for (const line of lines) {
    const nm = line.match(/^name:\s*(.+)$/i);
    if (nm) name = nm[1].trim().replace(/^["']|["']$/g, '');
    const dm = line.match(/^description:\s*(.+)$/i);
    if (dm) description = dm[1].trim().replace(/^["']|["']$/g, '');
    const am = line.match(/^agent:\s*(.+)$/i);
    if (am) agent = am[1].trim().replace(/^["']|["']$/g, '');
  }
  return { name, description, agent: agent || undefined };
}

function countFilesIn(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).length;
  } catch {
    return 0;
  }
}

function scanSkillsDir(dir: string, source: SkillInfo['source'], out: SkillInfo[], seen: Set<string>): void {
  if (!fs.existsSync(dir)) return;
  try {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const skillDir = path.join(dir, ent.name);
      const skillFile = path.join(skillDir, 'SKILL.md');
      if (!fs.existsSync(skillFile)) continue;
      const fm = parseFrontmatter(fs.readFileSync(skillFile, 'utf8'));
      const name = fm.name || ent.name;
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({
        name,
        description: fm.description || 'Skill instructions available in Agora',
        source,
        agent: fm.agent ?? null,
        scriptCount: countFilesIn(path.join(skillDir, 'scripts')),
        refCount: countFilesIn(path.join(skillDir, 'references')),
      });
    }
  } catch {
    /* ignore unreadable dir */
  }
}

export interface SkillExtraFile {
  filename: string;
  content: string;
}

function writeSkillSubfiles(baseDir: string, folder: 'scripts' | 'references', files?: SkillExtraFile[]): void {
  if (!Array.isArray(files) || !files.length) return;
  const sub = path.join(baseDir, folder);
  fs.mkdirSync(sub, { recursive: true });
  for (const f of files.slice(0, 20)) {
    const safe = path.basename(String(f.filename ?? '')).replace(/[<>:"/\\|?*]/g, '_').trim();
    if (!safe || safe === '.' || safe === '..') continue;
    fs.writeFileSync(path.join(sub, safe), String(f.content ?? ''), 'utf8');
  }
}

/** Create a custom workspace skill under `.agents/skills/<slug>/SKILL.md` (with optional scripts & references). */
export function createSkill(
  root: string,
  input: {
    name: string;
    description: string;
    instructions?: string;
    agent?: string | null;
    scripts?: SkillExtraFile[];
    references?: SkillExtraFile[];
  },
): SkillInfo[] {
  const name = input.name.trim();
  if (!name || name.length > 20) throw new Error('skill name must be 1-20 characters');
  const description = input.description.trim();
  if (!description) throw new Error('skill description is empty');
  const agent = input.agent && input.agent.trim() ? normalizeAgent(input.agent) : null;

  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || `skill-${Date.now()}`;
  const dir = path.join(root, '.agents', 'skills', slug);
  fs.mkdirSync(dir, { recursive: true });

  const oneLineDesc = description.replace(/\s+/g, ' ').slice(0, 200);
  const fmLines = ['---', `name: ${name}`, `description: ${oneLineDesc}`];
  if (agent) fmLines.push(`agent: ${agent}`);
  const body = (input.instructions && input.instructions.trim()) || description;
  fmLines.push('---', '', `# ${name}`, '', body, '');
  fs.writeFileSync(path.join(dir, 'SKILL.md'), fmLines.join('\n'), 'utf8');

  writeSkillSubfiles(dir, 'scripts', input.scripts);
  writeSkillSubfiles(dir, 'references', input.references);

  return discoverSkills(root);
}

/** Discover skills from workspace `.agents/skills` and local Antigravity skill directories. */
export function discoverSkills(root: string): SkillInfo[] {
  const out: SkillInfo[] = [];
  const seen = new Set<string>();
  scanSkillsDir(path.join(root, '.agents', 'skills'), 'workspace', out, seen);
  scanSkillsDir(path.join(os.homedir(), '.gemini', 'antigravity', 'skills'), 'user', out, seen);
  scanSkillsDir(path.join(os.homedir(), '.gemini', 'antigravity', 'builtin', 'skills'), 'builtin', out, seen);
  return out;
}

function agoraHomeDir(): string {
  return process.env.AGORA_HOME || path.join(os.homedir(), '.agora');
}

function prefsFilePath(): string {
  return path.join(agoraHomeDir(), 'agent-prefs.json');
}

function profileStatsPath(): string {
  return path.join(agoraHomeDir(), 'profile-stats.json');
}

export function readProfileStats(): ProfileStats {
  try {
    const raw = fs.readFileSync(profileStatsPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return {
      record5hTokens: Math.max(0, Number(parsed?.record5hTokens) || 0),
      record5hAt: Math.max(0, Number(parsed?.record5hAt) || 0),
    };
  } catch {
    return { record5hTokens: 0, record5hAt: 0 };
  }
}

export function recordFiveHourTokens(tokens: number): ProfileStats {
  const cur = readProfileStats();
  const clean = Math.max(0, Math.round(tokens || 0));
  if (clean <= cur.record5hTokens) return cur;
  const next: ProfileStats = { record5hTokens: clean, record5hAt: Date.now() };
  try {
    fs.mkdirSync(path.dirname(profileStatsPath()), { recursive: true });
    fs.writeFileSync(profileStatsPath(), JSON.stringify(next, null, 2), 'utf8');
  } catch {
    /* ignore */
  }
  return next;
}

function blankPref(): AgentPrefEntry {
  return { totalTokens: 0, totalWorkMs: 0, likes: 0, dislikes: 0 };
}

export function readAgentPrefs(): AgentPrefsMap {
  try {
    const raw = fs.readFileSync(prefsFilePath(), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as AgentPrefsMap) : {};
  } catch {
    return {};
  }
}

function writeAgentPrefs(map: AgentPrefsMap): AgentPrefsMap {
  try {
    fs.mkdirSync(path.dirname(prefsFilePath()), { recursive: true });
    fs.writeFileSync(prefsFilePath(), JSON.stringify(map, null, 2), 'utf8');
  } catch {
    /* ignore */
  }
  return map;
}

export function updateAgentPref(
  agent: string,
  patch: Partial<Pick<AgentPrefEntry, 'customName' | 'disabled' | 'behavior' | 'message' | 'selectedModel' | 'reasoningEffort'>>,
): AgentPrefsMap {
  const key = normalizeAgent(agent);
  const map = readAgentPrefs();
  const cur: AgentPrefEntry = { ...blankPref(), ...(map[key] ?? {}) };
  if (patch.customName !== undefined) cur.customName = String(patch.customName).trim().slice(0, 36) || undefined;
  if (patch.disabled !== undefined) cur.disabled = Boolean(patch.disabled);
  if (patch.behavior !== undefined) cur.behavior = String(patch.behavior).slice(0, 1200) || undefined;
  if (patch.message !== undefined) cur.message = String(patch.message).slice(0, 1200) || undefined;
  if (patch.selectedModel !== undefined) cur.selectedModel = String(patch.selectedModel).trim().slice(0, 80) || undefined;
  if (patch.reasoningEffort !== undefined) {
    const eff = String(patch.reasoningEffort).trim().toLowerCase();
    cur.reasoningEffort = /^(low|medium|high|xhigh|max|ultra)$/.test(eff) ? eff : undefined;
  }
  map[key] = cur;
  return writeAgentPrefs(map);
}

export function recordAgentFeedback(agent: string, kind: 'like' | 'dislike', delta: 1 | -1): AgentPrefsMap {
  const key = normalizeAgent(agent);
  const map = readAgentPrefs();
  const cur: AgentPrefEntry = { ...blankPref(), ...(map[key] ?? {}) };
  if (kind === 'like') cur.likes = Math.max(0, (cur.likes || 0) + delta);
  else cur.dislikes = Math.max(0, (cur.dislikes || 0) + delta);
  map[key] = cur;
  return writeAgentPrefs(map);
}

export function accumulateAgentStats(agent: string, tokensDelta: number, workMsDelta: number): void {
  if (tokensDelta <= 0 && workMsDelta <= 0) return;
  const key = normalizeAgent(agent);
  const map = readAgentPrefs();
  const cur: AgentPrefEntry = { ...blankPref(), ...(map[key] ?? {}) };
  if (tokensDelta > 0) cur.totalTokens = (cur.totalTokens || 0) + Math.round(tokensDelta);
  if (workMsDelta > 0) cur.totalWorkMs = (cur.totalWorkMs || 0) + Math.round(workMsDelta);
  map[key] = cur;
  writeAgentPrefs(map);
}
