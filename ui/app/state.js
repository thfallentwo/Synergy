export const KNOWN_ICONS = new Set([
  'antigravity',
  'claude',
  'claude-code',
  'codex',
  'copilot',
  'cursor',
  'deepseek',
  'gemini',
  'grok',
  'hermes',
  'kimi',
  'llama',
  'muse',
  'nemotron',
  'ollama',
  'perplexity',
]);

export const THEMES = [
  { value: 'dark', label: 'Obsidian Dark' },
  { value: 'light', label: 'Luminous Light' },
  { value: 'midnight', label: 'Midnight Blue' },
  { value: 'forest', label: 'Dark Forest' },
  { value: 'nord', label: 'Nord Slate' },
  { value: 'obsidian', label: 'Pure OLED' },
];

export const FONTS = [
  { value: 'inter', label: 'Inter (Modern)' },
  { value: 'system', label: 'System Sans' },
  { value: 'mono', label: 'JetBrains Mono' },
  { value: 'serif', label: 'Editorial Serif' },
];

export const EFFORT_STOPS = ['low', 'medium', 'high', 'xhigh', 'max'];

export const EFFORT_LABELS = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
};

export const MODE_LABELS = {
  direct: 'Direct',
  task: 'Task',
  code_review: 'Code Analysis',
  relay: 'Relay',
  debate: 'İstişare',
};

export const TASK_SUBMODES = [
  { value: 'code_review', label: 'Code Analysis' },
  { value: 'relay', label: 'Relay' },
  { value: 'debate', label: 'İstişare' },
];

const VALID_THEMES = new Set(THEMES.map((t) => t.value));
const VALID_FONTS = new Set(FONTS.map((f) => f.value));

function readJsonStorage(key, fallback) {
  try {
    if (typeof localStorage === 'undefined') return fallback;
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function readStringStorage(key, fallback) {
  try {
    if (typeof localStorage === 'undefined') return fallback;
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}

function normalizeTheme(val) {
  return VALID_THEMES.has(val) ? val : 'dark';
}

function normalizeFont(val) {
  return VALID_FONTS.has(val) ? val : 'inter';
}

export const store = {
  theme: normalizeTheme(readStringStorage('masiva-theme', 'dark')),
  accent: readStringStorage('masiva-accent', 'sapphire'),
  font: normalizeFont(readStringStorage('masiva-font', 'inter')),
  sidebarExpanded: false,
  rightPanelOpen: true,
  rightTab: 'live',
  activeView: null,
  settingsTab: 'appearance',
  settingsQuery: '',
  searchOpen: false,
  searchQuery: '',
  searchIdx: 0,
  liveTurns: [],
  expandedAgentsCard: null,
  conciseMode: readStringStorage('masiva-concise', '1') !== '0',
  taskAnim: readStringStorage('masiva-task-anim', '1') !== '0',
  topMode: 'direct',
  taskSubMode: 'code_review',
  chatModes: readJsonStorage('masiva-chat-modes', {}),
  selectedAgents: [],
  allowWrite: false,
  mcpTarget: '',
  catalog: [],
  state: null,
  events: [],
  diffs: [],
  liveSessions: [],
  memory: null,
  ollama: null,
  mcpSetup: null,
  apiKeys: [],
  skills: [],
  treeFiles: [],
  previewFile: null,
  gitStatus: null,
  usage: null,
  profileStats: null,
  prefs: {},
  projects: [],
  project: 'Masiva Labs',
  root: '',
  plusPopoverOpen: false,
  modelPopoverOpen: false,
  expandedModelAgent: null,
  mcpClientTab: 'antigravity',
  busy: false,
};

export function runnableAgents() {
  return store.catalog.filter((a) => a.capability === 'runnable');
}

export function mcpIdeAgents() {
  return store.catalog.filter((a) => a.capability === 'mcp_ide');
}

export function unconfiguredAgents() {
  return store.catalog.filter((a) => a.capability === 'unconfigured');
}

export function agentDisplay(slug) {
  const custom = store.prefs?.[slug]?.customName;
  if (custom) return custom;
  const hit = store.catalog.find((a) => a.agent === slug);
  if (hit) return hit.display;
  if (slug === 'openai') return 'OpenAI (GPT)';
  if (slug === 'human') return 'Sen';
  return slug || 'Ajan';
}

export function agentIconPath(slug) {
  if (slug === 'openai') return '/icons/codex.png';
  if (KNOWN_ICONS.has(slug)) return `/icons/${slug}.png`;
  return '/icons/codex.png';
}

export function syncSelectedAgents() {
  const runnable = runnableAgents();
  const runnableIds = new Set(runnable.map((a) => a.agent));
  store.selectedAgents = store.selectedAgents.filter((id) => runnableIds.has(id));

  if (!store.selectedAgents.length && runnable.length) {
    if (store.topMode === 'direct') {
      store.selectedAgents = [runnable[0].agent];
    } else {
      store.selectedAgents = runnable
        .slice(0, Math.min(2, runnable.length))
        .map((a) => a.agent);
    }
  } else if (store.topMode === 'direct' && store.selectedAgents.length > 1) {
    store.selectedAgents = [store.selectedAgents[0]];
  }
}

export function getChatMode(chatId) {
  if (chatId === undefined || chatId === null || chatId === '') return null;
  return store.chatModes[String(chatId)] ?? null;
}

export function lockChatMode(chatId, mode) {
  if (chatId === undefined || chatId === null || chatId === '') return;
  store.chatModes[String(chatId)] = mode;
  persistUiPrefs();
}

export function persistUiPrefs() {
  const safeTheme = normalizeTheme(store.theme);
  const safeFont = normalizeFont(store.font);
  store.theme = safeTheme;
  store.font = safeFont;

  if (typeof document !== 'undefined') {
    const root = document.documentElement;
    root.setAttribute('data-theme', safeTheme);
    root.setAttribute('data-accent', store.accent || 'sapphire');
    root.setAttribute('data-font', safeFont);
    root.setAttribute('data-task-anim', store.taskAnim === false ? 'off' : 'on');
  }
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem('masiva-theme', safeTheme);
    localStorage.setItem('masiva-accent', store.accent);
    localStorage.setItem('masiva-font', safeFont);
    localStorage.setItem('masiva-concise', store.conciseMode ? '1' : '0');
    localStorage.setItem('masiva-task-anim', store.taskAnim ? '1' : '0');
    localStorage.setItem('masiva-chat-modes', JSON.stringify(store.chatModes || {}));
  } catch {
    /* ignore storage quota/security errors */
  }
}
