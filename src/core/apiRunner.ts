import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CATALOG_AGENTS, describeAgent, MCP_IDE_AGENTS, normalizeAgent, type AgentCapability } from './agents';
import { readAgentPrefs } from './customization';

export const AGENT_PROVIDER_MAP: Record<string, string> = {
  codex: 'openai',
  openai: 'openai',
  claude: 'anthropic',
  'claude-code': 'anthropic',
  gemini: 'gemini',
  antigravity: 'gemini',
  deepseek: 'deepseek',
  grok: 'grok',
  kimi: 'kimi',
  nemotron: 'nemotron',
  perplexity: 'perplexity',
};

export const PROVIDER_MODELS: Record<string, string[]> = {
  openai: ['gpt-5.2', 'gpt-4o'],
  anthropic: ['claude-sonnet-4-5', 'claude-haiku-4-5'],
  gemini: ['gemini-2.5-flash', 'gemini-2.5-pro'],
  deepseek: ['deepseek-chat', 'deepseek-reasoner'],
  grok: ['grok-3-mini', 'grok-3'],
  kimi: ['moonshot-v1-8k', 'kimi-latest'],
  nemotron: ['nvidia/llama-3.1-nemotron-70b-instruct'],
  perplexity: ['sonar', 'sonar-pro'],
};

const OPENAI_COMPAT_ENDPOINTS: Record<string, string> = {
  openai: 'https://api.openai.com/v1/chat/completions',
  deepseek: 'https://api.deepseek.com/chat/completions',
  grok: 'https://api.x.ai/v1/chat/completions',
  kimi: 'https://api.moonshot.cn/v1/chat/completions',
  nemotron: 'https://integrate.api.nvidia.com/v1/chat/completions',
  perplexity: 'https://api.perplexity.ai/chat/completions',
};

function readKeyAndModel(root: string, provider: string): { key: string; model: string } | null {
  try {
    const file = path.join(root, '.synergy', 'api-keys.json');
    if (!fs.existsSync(file)) return null;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    const entry = raw[provider];
    const defaultModel = PROVIDER_MODELS[provider]?.[0] ?? '';
    if (typeof entry === 'string' && entry.trim()) return { key: entry.trim(), model: defaultModel };
    if (entry && typeof entry === 'object') {
      const k = String((entry as Record<string, unknown>).key ?? '').trim();
      const m = String((entry as Record<string, unknown>).model ?? '').trim() || defaultModel;
      if (k) return { key: k, model: m };
    }
    return null;
  } catch {
    return null;
  }
}

/** Check whether an agent has a direct local API key stored for Agora runner calls. */
export function hasAgentApiKey(root: string, agentRaw: string): boolean {
  const provider = AGENT_PROVIDER_MAP[normalizeAgent(agentRaw)];
  return provider ? readKeyAndModel(root, provider) !== null : false;
}

export interface CliRunOptions {
  model?: string;
  effort?: string;
  mode?: 'advisory' | 'workspace_write';
}

interface CliSpec {
  bin: string;
  args: (prompt: string, outFile?: string, opts?: CliRunOptions) => string[];
  useStdin?: boolean;
  installCmd: string;
  loginCmd?: string;
}

const quoteWinArg = (s: string) =>
  process.platform === 'win32' ? `"${s.replace(/[\r\n]+/g, ' ').replace(/"/g, '\\"')}"` : s;

function readCodexModelsCache(): { models: string[]; effortsByModel: Record<string, string[]> } {
  const cache = readJsonSafe(path.join(os.homedir(), '.codex', 'models_cache.json'));
  const raw = Array.isArray(cache?.models) ? cache.models : [];
  const models: string[] = [];
  const effortsByModel: Record<string, string[]> = {};
  for (const m of raw) {
    if (!m || typeof m.slug !== 'string') continue;
    if (m.visibility !== 'list' || m.slug === 'gpt-6.1-sol') continue;
    models.push(m.slug);
    const lvls = Array.isArray(m.supported_reasoning_levels)
      ? m.supported_reasoning_levels.map((x: any) => String(x?.effort ?? '')).filter(Boolean)
      : [];
    if (lvls.length) effortsByModel[m.slug] = lvls;
  }
  if (!models.length) {
    return {
      models: ['gpt-6-luna', 'gpt-5.6-terra', 'gpt-5.6-luna'],
      effortsByModel: {
        'gpt-6-luna': ['low', 'medium', 'high', 'xhigh', 'max'],
        'gpt-5.6-terra': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
        'gpt-5.6-luna': ['low', 'medium', 'high', 'xhigh', 'max'],
      },
    };
  }
  return { models, effortsByModel };
}

function pickCodexModel(): string | null {
  return readCodexModelsCache().models[0] ?? null;
}

const AGENT_CLI_SPECS: Record<string, CliSpec> = {
  claude: {
    bin: 'claude',
    args: (_p, _o, opts) => [
      '-p',
      '--output-format',
      'text',
      ...(opts?.model ? ['--model', opts.model] : []),
      ...(opts?.effort ? ['--effort', opts.effort] : []),
    ],
    useStdin: true,
    installCmd: 'npm install -g @anthropic-ai/claude-code',
    loginCmd: 'claude',
  },
  'claude-code': {
    bin: 'claude',
    args: (_p, _o, opts) => [
      '-p',
      '--output-format',
      'text',
      ...(opts?.model ? ['--model', opts.model] : []),
      ...(opts?.effort ? ['--effort', opts.effort] : []),
    ],
    useStdin: true,
    installCmd: 'npm install -g @anthropic-ai/claude-code',
    loginCmd: 'claude',
  },
  gemini: {
    bin: 'gemini',
    args: (_p, _o, opts) => ['-p', 'Respond_to_stdin', ...(opts?.model ? ['-m', opts.model] : [])],
    useStdin: true,
    installCmd: 'npm install -g @google/gemini-cli',
    loginCmd: 'gemini',
  },
  codex: {
    bin: 'codex',
    args: (_p, outFile, opts) => {
      const m = opts?.model || pickCodexModel();
      return [
        'exec',
        '--skip-git-repo-check',
        ...(opts?.mode === 'workspace_write' ? ['--full-auto'] : []),
        '--ephemeral',
        '--ignore-user-config',
        '--color',
        'never',
        ...(m ? ['-m', m] : []),
        ...(opts?.effort ? ['-c', `model_reasoning_effort=${opts.effort}`] : []),
        ...(outFile ? ['-o', outFile] : []),
        '-',
      ];
    },
    useStdin: true,
    installCmd: 'npm install -g @openai/codex',
    loginCmd: 'codex login',
  },
  copilot: {
    bin: 'copilot',
    args: (p) => ['-p', quoteWinArg(p)],
    installCmd: 'gh extension install github/gh-copilot',
  },
  ollama: {
    bin: 'ollama',
    args: (_p, _o, opts) => ['run', opts?.model || 'qwen2.5-coder:3b'],
    useStdin: true,
    installCmd: 'https://ollama.com/download',
  },
};

const cliExistsCache = new Map<string, { ok: boolean; ts: number }>();
const cliAuthCache = new Map<string, { ok: boolean; ts: number }>();

function readJsonSafe(file: string): Record<string, any> | null {
  try {
    if (!fs.existsSync(file)) return null;
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' ? (v as Record<string, any>) : null;
  } catch {
    return null;
  }
}

function resolveCliBin(bin: string, force = false): boolean {
  const now = Date.now();
  const cached = cliExistsCache.get(bin);
  if (!force && cached && now - cached.ts < 30_000) return cached.ok;
  let ok = false;
  try {
    const checker = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(checker, [bin], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    ok = out.length > 0;
  } catch {
    ok = false;
  }
  cliExistsCache.set(bin, { ok, ts: now });
  return ok;
}

/** Check whether a local CLI actually has valid login/credentials (never mark unauthenticated CLIs active). */
export function isCliAuthenticated(agentRaw: string, force = false): boolean {
  const ag = normalizeAgent(agentRaw);
  const now = Date.now();
  const cached = cliAuthCache.get(ag);
  if (!force && cached && now - cached.ts < 30_000) return cached.ok;

  const home = os.homedir();
  let ok = false;

  if (ag === 'claude' || ag === 'claude-code') {
    if (process.env.ANTHROPIC_API_KEY?.trim()) ok = true;
    else {
      const cj = readJsonSafe(path.join(home, '.claude.json'));
      const oa = cj?.oauthAccount;
      if (oa && typeof oa === 'object' && (oa.accountUuid || oa.emailAddress)) ok = true;
      else {
        const creds = readJsonSafe(path.join(home, '.claude', '.credentials.json'));
        if (creds && (creds.claudeAiOauth?.accessToken || creds.oauth?.accessToken || creds.apiKey)) ok = true;
      }
    }
  } else if (ag === 'gemini') {
    if (process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim()) ok = true;
    else {
      const oauth = readJsonSafe(path.join(home, '.gemini', 'oauth_creds.json'));
      const accts = readJsonSafe(path.join(home, '.gemini', 'google_accounts.json'));
      if (oauth && (oauth.access_token || oauth.refresh_token)) ok = true;
      else if (accts && (accts.active || (Array.isArray(accts.old) && accts.old.length))) ok = true;
    }
  } else if (ag === 'codex') {
    if (process.env.OPENAI_API_KEY?.trim()) ok = true;
    else {
      const auth = readJsonSafe(path.join(home, '.codex', 'auth.json'));
      if (auth && (auth.OPENAI_API_KEY || auth.tokens?.access_token || auth.access_token)) ok = true;
      else if (resolveCliBin('codex')) {
        try {
          execFileSync('codex', ['login', 'status'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 2000 });
          ok = true;
        } catch {
          ok = false;
        }
      }
    }
  } else if (ag === 'copilot') {
    if (process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim()) ok = true;
    else {
      const hosts = path.join(home, '.config', 'github-copilot', 'hosts.json');
      const apps = path.join(home, '.config', 'github-copilot', 'apps.json');
      ok = Boolean(readJsonSafe(hosts) || readJsonSafe(apps));
    }
  } else if (ag === 'ollama') {
    ok = false; // Handled async via isOllamaRunning() in getCliStatusList()
  }

  cliAuthCache.set(ag, { ok, ts: now });
  return ok;
}

/** Check whether an agent has an installed local CLI (`claude`, `gemini`, `codex`, `copilot`, `ollama`, `muse`). */
export function hasAgentCli(agentRaw: string): boolean {
  const spec = AGENT_CLI_SPECS[normalizeAgent(agentRaw)];
  return spec ? resolveCliBin(spec.bin) : false;
}

/** Check whether an agent CLI is both installed and authenticated. */
export function hasReadyAgentCli(agentRaw: string): boolean {
  return hasAgentCli(agentRaw) && isCliAuthenticated(agentRaw);
}

export interface CliStatusEntry {
  agent: string;
  installed: boolean;
  authenticated: boolean;
  bin: string;
  installCmd: string;
  running?: boolean;
  models?: string[];
  efforts?: string[];
  effortsByModel?: Record<string, string[]>;
}

export async function isOllamaRunning(fetchImpl: typeof fetch = fetch): Promise<{ running: boolean; models: string[] }> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 700);
    const r = await fetchImpl('http://127.0.0.1:11434/api/tags', { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return { running: false, models: [] };
    const j = (await r.json()) as { models?: Array<{ name?: string }> };
    const models = (j.models ?? []).map((m) => String(m.name ?? '')).filter(Boolean);
    return { running: true, models };
  } catch {
    return { running: false, models: [] };
  }
}

export async function runOllamaCall(
  prompt: string,
  systemPrompt = 'You are an AI assistant collaborating inside Agora. Reply concisely.',
  fetchImpl: typeof fetch = fetch,
  preferredModel?: string,
): Promise<{ text: string | null; error?: string }> {
  const st = await isOllamaRunning(fetchImpl);
  if (!st.running) return { text: null, error: 'Ollama servisi çalışmıyor (ollama serve başlatın).' };
  const model = preferredModel && st.models.includes(preferredModel) ? preferredModel : st.models[0];
  if (!model) return { text: null, error: 'Ollama kurulu ama yüklü model yok (örn: ollama pull qwen2.5-coder:3b).' };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 45_000);
    const r = await fetchImpl('http://127.0.0.1:11434/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
      }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!r.ok) return { text: null, error: `Ollama HTTP ${r.status}` };
    const j = (await r.json()) as { message?: { content?: string } };
    return { text: j.message?.content?.trim() || null };
  } catch (e) {
    return { text: null, error: (e as Error).message };
  }
}

export async function getCliStatusList(): Promise<Record<string, CliStatusEntry>> {
  const out: Record<string, CliStatusEntry> = {};
  const ol = await isOllamaRunning();
  const codexCache = readCodexModelsCache();
  for (const [ag, spec] of Object.entries(AGENT_CLI_SPECS)) {
    const installed = resolveCliBin(spec.bin, true) || (ag === 'ollama' && ol.running);
    const authenticated =
      ag === 'ollama' ? ol.running && ol.models.length > 0 : installed && isCliAuthenticated(ag, true);
    const extra: Partial<CliStatusEntry> = {};
    if (ag === 'ollama') {
      extra.running = ol.running;
      extra.models = ol.models;
    } else if (ag === 'codex') {
      extra.models = codexCache.models;
      extra.effortsByModel = codexCache.effortsByModel;
    } else if (ag === 'claude' || ag === 'claude-code') {
      extra.models = ['sonnet', 'opus', 'haiku', 'claude-sonnet-4-5', 'claude-opus-4-5', 'claude-haiku-4-5'];
      extra.efforts = ['low', 'medium', 'high'];
    } else if (ag === 'gemini') {
      extra.models = ['gemini-2.5-pro', 'gemini-2.5-flash'];
    }
    out[ag] = {
      agent: ag,
      installed,
      authenticated,
      bin: spec.bin,
      installCmd: spec.installCmd,
      ...extra,
    };
  }
  return out;
}

export function setupAgentCli(agentRaw: string): { ok: true; mode: 'login' | 'install'; message: string } {
  const ag = normalizeAgent(agentRaw);
  const spec = AGENT_CLI_SPECS[ag];
  if (!spec) throw new Error(`No 1-click CLI setup available for ${ag}`);
  const installed = resolveCliBin(spec.bin, true);
  const cmdToRun = installed && spec.loginCmd ? spec.loginCmd : spec.installCmd;
  const mode: 'login' | 'install' = installed && spec.loginCmd ? 'login' : 'install';

  if (process.platform === 'win32') {
    spawn('cmd.exe', ['/c', 'start', '""', 'cmd.exe', '/k', cmdToRun], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    }).unref();
  } else if (process.platform === 'darwin') {
    spawn('osascript', ['-e', `tell application "Terminal" to do script "${cmdToRun.replace(/"/g, '\\"')}"`], {
      detached: true,
      stdio: 'ignore',
    }).unref();
  } else {
    spawn('sh', ['-c', cmdToRun], { detached: true, stdio: 'ignore' }).unref();
  }

  return {
    ok: true,
    mode,
    message:
      mode === 'login'
        ? `${spec.bin} zaten kurulu — giriş penceresi açıldı (${cmdToRun}).`
        : `${spec.bin} kurulumu başlatıldı (${cmdToRun}). Tamamlanınca yeniden dene.`,
  };
}

/** Run a local agent CLI in headless prompt mode inside `root` and return its reply text + optional error. */
export function runAgentCliWithError(
  root: string,
  agentRaw: string,
  prompt: string,
  systemPrompt = 'You are an AI assistant collaborating inside Agora. Reply concisely and clearly.',
  timeoutMs = 120_000,
  opts?: CliRunOptions,
): Promise<{ text: string | null; error?: string }> {
  const agent = normalizeAgent(agentRaw);
  const spec = AGENT_CLI_SPECS[agent];
  if (!spec || !resolveCliBin(spec.bin)) return Promise.resolve({ text: null, error: 'CLI not installed' });

  const fullPrompt = `${systemPrompt}\n\nUser request:\n${prompt}`.slice(0, 8000);
  const outFile =
    agent === 'codex'
      ? path.join(os.tmpdir(), `masiva-codex-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`)
      : undefined;

  const readOutFile = (): string => {
    if (!outFile) return '';
    try {
      return fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8').trim() : '';
    } catch {
      return '';
    } finally {
      try {
        if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
      } catch {
        /* ignore */
      }
    }
  };

  return new Promise((resolve) => {
    let out = '';
    let errOut = '';
    let settled = false;
    const child = spawn(spec.bin, spec.args(fullPrompt, outFile, opts), {
      cwd: root,
      stdio: [spec.useStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      windowsHide: true,
    });
    if (spec.useStdin && child.stdin) {
      child.stdin.write(fullPrompt);
      child.stdin.end();
    }
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* ignore */ }
      const reply = (readOutFile() || out.trim()).slice(0, 3000);
      resolve({ text: reply || null, error: reply ? undefined : 'CLI zaman aşımına uğradı' });
    }, timeoutMs);

    child.stdout?.on('data', (d: Buffer) => {
      if (out.length < 16_000) out += d.toString('utf8');
    });
    child.stderr?.on('data', (d: Buffer) => {
      if (errOut.length < 4000) errOut += d.toString('utf8');
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      readOutFile();
      resolve({ text: null, error: err.message });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const reply = (readOutFile() || out.trim()).slice(0, 3000);
      if (reply) {
        resolve({ text: reply });
      } else {
        const tailErr = errOut.trim().slice(-260);
        const netHint = /request timed out/i.test(errOut)
          ? ' (OpenAI bağlantı zaman aşımı — internet/VPN ayarını kontrol et)'
          : '';
        resolve({ text: null, error: (tailErr || (code ? `CLI çıkış kodu: ${code}` : 'Boş yanıt')) + netHint });
      }
    });
  });
}

export async function runAgentCliCall(
  root: string,
  agentRaw: string,
  prompt: string,
  systemPrompt = 'You are an AI assistant collaborating inside Agora. Reply concisely and clearly.',
  timeoutMs = 120_000,
  opts?: CliRunOptions,
): Promise<string | null> {
  const res = await runAgentCliWithError(root, agentRaw, prompt, systemPrompt, timeoutMs, opts);
  return res.text;
}

/** Execute a direct LLM API call for an agent using `.synergy/api-keys.json`. Returns null if no key is configured. */
export async function runAgentApiCall(
  root: string,
  agentRaw: string,
  prompt: string,
  systemPrompt = 'You are an AI assistant collaborating inside Agora. Reply concisely and clearly.',
  modelOverride?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const agent = normalizeAgent(agentRaw);
  const provider = AGENT_PROVIDER_MAP[agent];
  if (!provider) return null;
  const creds = readKeyAndModel(root, provider);
  if (!creds) return null;
  const model = (modelOverride || creds.model || '').trim();

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45_000);
  try {
    if (provider === 'anthropic') {
      const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': creds.key,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: model || 'claude-sonnet-4-5',
          max_tokens: 1500,
          system: systemPrompt,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) return null;
      const j = (await res.json()) as { content?: Array<{ text?: string }> };
      return j.content?.[0]?.text?.trim() || null;
    }

    if (provider === 'gemini') {
      const mId = model || 'gemini-2.5-flash';
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(mId)}:generateContent?key=${encodeURIComponent(creds.key)}`;
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `${systemPrompt}\n\n${prompt}` }] }],
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) return null;
      const j = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
      return j.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
    }

    const endpoint = OPENAI_COMPAT_ENDPOINTS[provider];
    if (!endpoint) return null;
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${creds.key}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
        max_tokens: 1500,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return j.choices?.[0]?.message?.content?.trim() || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface AgentCatalogEntry {
  agent: string;
  display: string;
  capability: AgentCapability;
  transport: 'api' | 'cli' | 'ollama' | 'mcp_ide' | 'none';
  provider?: string;
  cliInstalled?: boolean;
  cliAuthenticated?: boolean;
  models: string[];
  defaultModel?: string;
  efforts?: string[];
  effortsByModel?: Record<string, string[]>;
  selectedModel?: string;
  reasoningEffort?: string;
  reason?: string;
}

export interface UnifiedRunResult {
  ok: boolean;
  reply?: string;
  error?: string;
  transport: 'api' | 'cli' | 'ollama' | 'none';
}

/** Return the honest 3-class agent catalog (Runnable vs Pull-based MCP IDE vs Unconfigured). */
export async function getAgentCatalog(root: string): Promise<AgentCatalogEntry[]> {
  const cliMap = await getCliStatusList();
  const prefs = readAgentPrefs();
  const out: AgentCatalogEntry[] = [];

  for (const ag of CATALOG_AGENTS) {
    const desc = describeAgent(ag);
    const provider = AGENT_PROVIDER_MAP[ag];
    const cli = cliMap[ag];
    const pref = prefs[ag];

    if (MCP_IDE_AGENTS.has(ag)) {
      out.push({
        agent: ag,
        display: desc.display,
        capability: 'mcp_ide',
        transport: 'mcp_ide',
        provider,
        cliInstalled: cli?.installed,
        cliAuthenticated: cli?.authenticated,
        models: [],
        reason: 'IDE MCP Oturumu (pull-based; read_feed / handoff ile görev alır)',
      });
      continue;
    }

    const hasKey = hasAgentApiKey(root, ag);
    if (hasKey && provider) {
      const models = PROVIDER_MODELS[provider] ?? [];
      out.push({
        agent: ag,
        display: desc.display,
        capability: 'runnable',
        transport: 'api',
        provider,
        models,
        defaultModel: models[0],
        selectedModel: pref?.selectedModel,
        reasoningEffort: pref?.reasoningEffort,
      });
      continue;
    }

    if (ag === 'ollama') {
      const models = cli?.models ?? [];
      if (cli?.running && models.length > 0) {
        out.push({
          agent: ag,
          display: desc.display,
          capability: 'runnable',
          transport: 'ollama',
          cliInstalled: true,
          cliAuthenticated: true,
          models,
          defaultModel: models[0],
          selectedModel: pref?.selectedModel,
        });
      } else {
        out.push({
          agent: ag,
          display: desc.display,
          capability: 'unconfigured',
          transport: 'none',
          cliInstalled: cli?.installed ?? false,
          cliAuthenticated: false,
          models: [],
          reason: cli?.running ? 'Ollama çalışıyor ama yüklü model yok' : 'Ollama servisi çalışmıyor',
        });
      }
      continue;
    }

    if (cli?.authenticated) {
      const models = cli.models ?? [];
      out.push({
        agent: ag,
        display: desc.display,
        capability: 'runnable',
        transport: 'cli',
        provider,
        cliInstalled: cli.installed,
        cliAuthenticated: true,
        models,
        defaultModel: models[0],
        efforts: cli.efforts,
        effortsByModel: cli.effortsByModel,
        selectedModel: pref?.selectedModel,
        reasoningEffort: pref?.reasoningEffort,
      });
      continue;
    }

    out.push({
      agent: ag,
      display: desc.display,
      capability: 'unconfigured',
      transport: 'none',
      provider,
      cliInstalled: cli?.installed ?? false,
      cliAuthenticated: false,
      models: [],
      reason: cli?.installed ? `${cli.bin} kurulu ama giriş yapılmamış` : 'API anahtarı veya CLI bağlantısı yok',
    });
  }

  return out;
}

/** Execute a prompt against any runnable agent via API -> Ollama -> authenticated CLI in unified fashion. */
export async function runAgentUnified(
  root: string,
  agentRaw: string,
  prompt: string,
  opts?: { systemPrompt?: string; mode?: 'advisory' | 'workspace_write'; timeoutMs?: number },
): Promise<UnifiedRunResult> {
  const ag = normalizeAgent(agentRaw);
  const prefs = readAgentPrefs();
  const ap = prefs[ag];
  const sys =
    opts?.systemPrompt ||
    'You are an engineering agent inside Masiva Labs. Use the provided project context and be clear, accurate, and actionable.';

  if (hasAgentApiKey(root, ag)) {
    const reply = await runAgentApiCall(root, ag, prompt, sys, ap?.selectedModel);
    if (reply) return { ok: true, reply, transport: 'api' };
    return { ok: false, error: `${ag} API isteği başarısız oldu veya boş yanıt döndü.`, transport: 'api' };
  }

  if (ag === 'ollama') {
    const r = await runOllamaCall(prompt, sys, fetch, ap?.selectedModel);
    if (r.text) return { ok: true, reply: r.text, transport: 'ollama' };
    return { ok: false, error: r.error || 'Ollama yanıt veremedi.', transport: 'ollama' };
  }

  if (hasReadyAgentCli(ag)) {
    const r = await runAgentCliWithError(root, ag, prompt, sys, opts?.timeoutMs ?? 120_000, {
      model: ap?.selectedModel,
      effort: ap?.reasoningEffort,
      mode: opts?.mode ?? 'advisory',
    });
    if (r.text) return { ok: true, reply: r.text, transport: 'cli' };
    return { ok: false, error: r.error || `${ag} CLI yanıt veremedi.`, transport: 'cli' };
  }

  const reason = MCP_IDE_AGENTS.has(ag)
    ? `${ag} bir IDE MCP oturumudur; doğrudan prompt yerine handoff/feed üzerinden görev alır.`
    : hasAgentCli(ag)
      ? `${ag} CLI kurulu ancak oturum açılmamış.`
      : `${ag} için aktif API anahtarı veya CLI yok.`;
  return { ok: false, error: reason, transport: 'none' };
}
