const KINDS: Array<[RegExp, string]> = [
  [/claude[\s_-]*code/i, 'claude-code'],
  [/claude/i, 'claude'],
  [/cursor/i, 'cursor'],
  [/gemini/i, 'gemini'],
  [/antigravity/i, 'antigravity'],
  [/codex|openai|chatgpt/i, 'codex'],
  [/kimi|moonshot/i, 'kimi'],
  [/hermes/i, 'hermes'],
  [/grok/i, 'grok'],
  [/copilot/i, 'copilot'],
  [/windsurf/i, 'windsurf'],
  [/^(human|you|user|dev|developer)$/i, 'human'],
];

/** Normalize free-form agent names ("Claude Code", "CLAUDE") to one stable key. */
export function normalizeAgent(raw: string | undefined | null): string {
  const name = (raw ?? '').trim();
  if (!name) return 'agent';
  for (const [re, kind] of KINDS) if (re.test(name)) return kind;
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  return slug || 'agent';
}

const PRETTY: Record<string, string> = {
  claude: 'Claude',
  'claude-code': 'Claude Code',
  cursor: 'Cursor',
  gemini: 'Gemini CLI',
  antigravity: 'Antigravity',
  codex: 'Codex',
  copilot: 'Copilot',
  kimi: 'Kimi',
  hermes: 'Hermes Agent',
  grok: 'Grok Bot',
  windsurf: 'Windsurf',
  human: '[Human]',
};

export function describeAgent(name: string): { display: string; kind: string } {
  const hit = KINDS.find(([, k]) => k === name);
  return { display: PRETTY[name] ?? name, kind: hit ? hit[1] : 'other' };
}
