import { execFileSync, spawn } from 'node:child_process';
import { normalizeAgent } from './agents';

const AGENT_TARGETS: Record<string, { cmds: string[]; url: string }> = {
  antigravity: { cmds: ['antigravity', 'agy'], url: 'https://antigravity.google' },
  cursor: { cmds: ['cursor'], url: 'https://cursor.com' },
  claude: { cmds: ['claude'], url: 'https://claude.ai' },
  'claude-code': { cmds: ['claude'], url: 'https://claude.ai/code' },
  codex: { cmds: ['codex'], url: 'https://chatgpt.com/codex' },
  gemini: { cmds: ['gemini'], url: 'https://gemini.google.com' },
  deepseek: { cmds: ['deepseek'], url: 'https://chat.deepseek.com' },
  nemotron: { cmds: [], url: 'https://build.nvidia.com' },
  perplexity: { cmds: ['perplexity'], url: 'https://www.perplexity.ai' },
  grok: { cmds: [], url: 'https://grok.com' },
  kimi: { cmds: [], url: 'https://kimi.moonshot.cn' },
  copilot: { cmds: ['github-copilot'], url: 'https://github.com/features/copilot' },
  hermes: { cmds: ['hermes'], url: 'https://hermes-agent.nousresearch.com' },
  ollama: { cmds: ['ollama'], url: 'https://ollama.com' },
  muse: { cmds: ['muse'], url: 'https://muse.ai' },
};

function commandExists(cmd: string): string | null {
  try {
    const checker = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(checker, [cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return out.split(/\r?\n/)[0]?.trim() || null;
  } catch {
    return null;
  }
}

function launchUrl(url: string): void {
  if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  } else if (process.platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  }
}

/** Resolve an agent's desktop binary or web URL without executing side effects if `dryRun` is true. */
export function resolveAgentLaunchTarget(agentRaw: string): { agent: string; url: string; cmd: string | null } {
  const agent = normalizeAgent(agentRaw);
  const spec = AGENT_TARGETS[agent];
  if (!spec) throw new Error(`unknown agent: ${agent}`);
  for (const c of spec.cmds) {
    if (commandExists(c)) return { agent, url: spec.url, cmd: c };
  }
  return { agent, url: spec.url, cmd: null };
}

/** Open the agent's local desktop application if installed, otherwise open its web page. */
export function openAgentTarget(agentRaw: string): { ok: true; agent: string; opened: string; mode: 'app' | 'web' } {
  const target = resolveAgentLaunchTarget(agentRaw);
  if (target.cmd) {
    spawn(target.cmd, [], { detached: true, stdio: 'ignore', shell: process.platform === 'win32' }).unref();
    return { ok: true, agent: target.agent, opened: target.cmd, mode: 'app' };
  }
  launchUrl(target.url);
  return { ok: true, agent: target.agent, opened: target.url, mode: 'web' };
}
