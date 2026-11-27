import { mountCanvas } from './canvas.js';
import { renderCustomSelect } from './customSelect.js';
import { escapeHtml } from './markdown.js';
import {
  FONTS,
  THEMES,
  agentDisplay,
  agentIconPath,
  mcpIdeAgents,
  runnableAgents,
  store,
  unconfiguredAgents,
} from './state.js';

const ACCENT_SWATCHES = [
  { id: 'sapphire', label: 'Safir', color: '#67b8ff' },
  { id: 'emerald', label: 'Zümrüt', color: '#34d399' },
  { id: 'violet', label: 'Menekşe', color: '#a78bfa' },
  { id: 'amber', label: 'Kehribar', color: '#fbbf24' },
  { id: 'rose', label: 'Gül', color: '#fb7185' },
];

const LANG_OPTIONS = [
  { value: 'tr', label: 'Türkçe (tr)' },
  { value: 'en', label: 'English (en)' },
  { value: 'de', label: 'Deutsch (de)' },
  { value: 'fr', label: 'Français (fr)' },
  { value: 'es', label: 'Español (es)' },
  { value: 'ja', label: '日本語 (ja)' },
];

const AGENT_API_PROVIDER_MAP = {
  codex: 'openai',
  openai: 'openai',
  claude: 'anthropic',
  'claude-code': 'anthropic',
  gemini: 'gemini',
  deepseek: 'deepseek',
  perplexity: 'perplexity',
  grok: 'grok',
  kimi: 'kimi',
  nemotron: 'nemotron',
  copilot: 'copilot',
};

const AGENT_MCP_KEY_MAP = {
  antigravity: 'antigravity',
  cursor: 'cursor',
  'claude-code': 'claudeCode',
  codex: 'codex',
  gemini: 'gemini',
};

const LUCIDE_PATHS = {
  working: '<path d="M21 12a9 9 0 1 1-6.219-8.56" />',
  reading: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" /><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />',
  editing: '<path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" /><path d="m15 5 4 4" />',
  running: '<polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />',
  thinking: '<path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z" /><path d="M5 3v4" /><path d="M19 17v4" /><path d="M3 5h4" /><path d="M17 19h4" />',
  idle: '<circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />',
  user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />',
  palette: '<circle cx="13.5" cy="6.5" r=".5" fill="currentColor" /><circle cx="17.5" cy="10.5" r=".5" fill="currentColor" /><circle cx="8.5" cy="7.5" r=".5" fill="currentColor" /><circle cx="6.5" cy="12.5" r=".5" fill="currentColor" /><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z" />',
  sliders: '<line x1="4" y1="21" x2="4" y2="14" /><line x1="4" y1="10" x2="4" y2="3" /><line x1="12" y1="21" x2="12" y2="12" /><line x1="12" y1="8" x2="12" y2="3" /><line x1="20" y1="21" x2="20" y2="16" /><line x1="20" y1="12" x2="20" y2="3" /><line x1="2" y1="14" x2="6" y2="14" /><line x1="10" y1="8" x2="14" y2="8" /><line x1="18" y1="16" x2="22" y2="16" />',
  cpu: '<rect x="4" y="4" width="16" height="16" rx="2" /><rect x="9" y="9" width="6" height="6" /><path d="M15 2v2" /><path d="M15 20v2" /><path d="M2 15h2" /><path d="M2 9h2" /><path d="M20 15h2" /><path d="M20 9h2" /><path d="M9 2v2" /><path d="M9 20v2" />',
  git: '<circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" /><path d="M6 21V9a9 9 0 0 0 9 9" />',
  keyboard: '<rect x="2" y="4" width="20" height="16" rx="2" /><path d="M6 8h.001" /><path d="M10 8h.001" /><path d="M14 8h.001" /><path d="M18 8h.001" /><path d="M8 12h.001" /><path d="M12 12h.001" /><path d="M16 12h.001" /><path d="M7 16h10" />',
  search: '<circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />',
  check: '<polyline points="20 6 9 17 4 12" />',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />',
  folder: '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />',
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />',
};

export function lucideIcon(name, cls = '') {
  const path = LUCIDE_PATHS[name] || LUCIDE_PATHS.idle;
  const extra = name === 'working' ? `lucide-spin ${cls}`.trim() : cls.trim();
  const classAttr = extra ? ` class="lucide-ico ${escapeHtml(extra)}"` : ' class="lucide-ico"';
  return `<svg${classAttr} viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
}

const SETTINGS_CATEGORIES = [
  { id: 'account', label: 'Hesap & Profil', icon: 'user' },
  { id: 'appearance', label: 'Görünüm', icon: 'palette' },
  { id: 'general', label: 'Genel & Dil', icon: 'sliders' },
  { id: 'skills', label: 'Yetenekler', icon: 'cpu' },
  { id: 'git', label: 'Git & Bağlantılar', icon: 'git' },
  { id: 'shortcuts', label: 'Kısayollar', icon: 'keyboard' },
];

let cleanupCanvas = null;

function formatCompact(n) {
  const num = Number(n) || 0;
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}k`;
  return String(num);
}

function formatDurationMs(ms) {
  const totalMin = Math.max(0, Math.floor((Number(ms) || 0) / 60_000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}s ${m}dk` : `${m}dk`;
}

function detectActivityKind(item) {
  const raw = `${item?.activity || ''} ${item?.action || ''} ${item?.status || ''} ${item?.summary || item?.last_summary || ''}`.toLowerCase();
  if (raw.includes('edit') || raw.includes('write') || raw.includes('düzenl') || raw.includes('yaz')) {
    return { kind: 'editing', label: 'Editing' };
  }
  if (raw.includes('read') || raw.includes('inspect') || raw.includes('oku') || raw.includes('incel')) {
    return { kind: 'reading', label: 'Reading' };
  }
  if (raw.includes('run') || raw.includes('exec') || raw.includes('test') || raw.includes('komut') || raw.includes('çalıştır')) {
    return { kind: 'running', label: 'Running' };
  }
  if (raw.includes('think') || raw.includes('plan') || raw.includes('düşün') || raw.includes('analiz')) {
    return { kind: 'thinking', label: 'Thinking' };
  }
  if (item?.status === 'working' || item?.active || raw.includes('work') || raw.includes('çalış')) {
    return { kind: 'working', label: 'Working' };
  }
  return { kind: 'idle', label: 'Idle' };
}

function renderUsageBars(usage) {
  const items = usage?.items ?? [];
  if (!items.length) {
    return '<div class="card-desc">Bu pencerede henüz token kullanımı yok.</div>';
  }
  return items
    .map(
      (u) => `
    <div class="usage-row">
      <div class="row-between">
        <div style="display:flex;align-items:center;gap:8px;min-width:0">
          <img class="agent-icon" src="${agentIconPath(u.agent)}" alt="" />
          <span style="font-weight:600;font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(u.display || agentDisplay(u.agent))}</span>
        </div>
        <span style="font-size:11.5px;color:var(--text-muted);flex-shrink:0">${escapeHtml(u.label || formatCompact(u.tokens))} · %${u.percent ?? 0}</span>
      </div>
      <div class="usage-track">
        <div class="usage-fill" style="width:${Math.min(100, Math.max(0, Number(u.percent) || 0))}%"></div>
      </div>
    </div>
  `,
    )
    .join('');
}

function renderLiveTab() {
  const liveTurns = Array.isArray(store.liveTurns) ? store.liveTurns : [];
  const stateAgents = (store.state?.agents ?? []).filter((a) => a.status !== 'offline');
  const seen = new Set();
  const rows = [];

  for (const t of liveTurns) {
    const slug = t.agent || t.name || 'agent';
    seen.add(slug);
    const act = detectActivityKind({ ...t, active: true });
    rows.push({
      slug,
      display: t.display || agentDisplay(slug),
      kind: act.kind,
      label: act.label,
      file: t.file || t.last_file || '',
      summary: t.summary || t.text || 'İşlem sürüyor...',
      isWorking: true,
    });
  }

  for (const a of stateAgents) {
    if (seen.has(a.name)) continue;
    const isWorking = a.status === 'working';
    const act = detectActivityKind(a);
    rows.push({
      slug: a.name,
      display: a.display || agentDisplay(a.name),
      kind: isWorking ? (act.kind === 'idle' ? 'working' : act.kind) : 'idle',
      label: isWorking ? (act.kind === 'idle' ? 'Working' : act.label) : 'Idle',
      file: a.last_file || '',
      summary: a.last_summary || (isWorking ? 'Görev üzerinde çalışıyor' : 'Hazır'),
      isWorking,
    });
  }

  const activeCount = rows.filter((r) => r.isWorking).length;
  const readyCount = runnableAgents().length;
  const usage = store.usage || { resetInMs: 0, items: [] };

  return `
    <div class="card">
      <div class="card-title">
        <span>Şu An Çalışıyor</span>
        <span class="agent-badge">${activeCount > 0 ? `${activeCount} Aktif` : `${readyCount} Hazır`}</span>
      </div>
      ${
        rows.length
          ? `<div class="live-activity-list">
              ${rows
                .map(
                  (r) => `
                <div class="live-agent-row${r.isWorking ? ' is-working' : ''}">
                  <div class="live-agent-head">
                    <div style="display:flex;align-items:center;gap:8px;min-width:0">
                      <img class="agent-icon" src="${agentIconPath(r.slug)}" alt="" />
                      <span class="live-agent-name">${escapeHtml(r.display)}</span>
                    </div>
                    <span class="live-act-badge is-${escapeHtml(r.kind)}">
                      ${lucideIcon(r.kind)}
                      <span>${escapeHtml(r.label)}</span>
                    </span>
                  </div>
                  ${r.file ? `<div class="live-agent-file mono-text">${escapeHtml(r.file)}</div>` : ''}
                  <div class="live-agent-summary">${escapeHtml(String(r.summary).slice(0, 120))}</div>
                </div>
              `,
                )
                .join('')}
            </div>`
          : `<div class="card-desc">Şu an aktif görev yok — ajanlar hazır (${readyCount} çalıştırılabilir ajan).</div>`
      }
    </div>

    <div class="card">
      <div class="card-title">
        <span>5 Saatlik Limit Sayacı</span>
        <span class="muted-sub">Sıfırlanma: ${escapeHtml(formatDurationMs(usage.resetInMs))}</span>
      </div>
      ${renderUsageBars(usage)}
    </div>
  `;
}

function renderMemoryTab() {
  const mem = store.memory?.memory;
  const brief = store.memory?.handoffBrief || '';
  const ctxMd = store.memory?.contextMarkdown || '';
  const candidates = [...mcpIdeAgents(), ...runnableAgents()];
  const targetOptions = candidates.length
    ? candidates.map((a) => ({ value: a.agent, label: `${a.display} (${a.transport})` }))
    : [{ value: 'antigravity', label: 'Antigravity (mcp)' }];

  const curTarget =
    document.getElementById('hof-to-select')?.dataset?.value ||
    store.handoffTarget ||
    targetOptions[0]?.value ||
    'antigravity';

  return `
    <div class="card">
      <div class="card-title">
        <span>Kota Duvarı Devri (0 Kopyala-Yapıştır)</span>
      </div>
      <div class="card-desc">Limit dolduğunda başka modele veya editöre geçmek için tek tıkla güncel bağlam özetini al veya doğrudan görev devret.</div>
      <button type="button" class="btn btn-primary" data-copy-encoded="${encodeURIComponent(brief)}">Limit Devri Özetini Kopyala</button>
    </div>

    <div class="card">
      <div class="card-title"><span>Proje Hedefi & Karar Ekle</span></div>
      <input id="mem-goal-input" class="field" placeholder="Ana proje hedefi..." value="${escapeHtml(mem?.goal || '')}" />
      <input id="mem-decision-input" class="field" placeholder="Yeni karar notu (opsiyonel)..." />
      <button type="button" class="btn" id="btn-save-memory">Hafızaya Kaydet</button>
    </div>

    <div class="card">
      <div class="card-title"><span>Ajana Görev Devret (Handoff)</span></div>
      ${renderCustomSelect({
        id: 'hof-to-select',
        name: 'hof-to',
        value: curTarget,
        options: targetOptions,
        placeholder: 'Hedef ajan seç...',
      })}
      <input id="hof-goal-input" class="field" placeholder="Devredilecek görev..." />
      <input id="hof-files-input" class="field" placeholder="İlgili dosyalar (virgülle, örn: src/auth.ts)" />
      <button type="button" class="btn btn-primary" id="btn-send-handoff">Handoff Gönder</button>
    </div>

    <div class="card">
      <div class="card-title">
        <span>.synergy/context.md</span>
        <button type="button" class="sub-chip" data-copy-encoded="${encodeURIComponent(ctxMd)}">Kopyala</button>
      </div>
      <pre class="mono-box">${escapeHtml(ctxMd || 'Henüz bağlam yok.')}</pre>
    </div>
  `;
}

function renderLocksTab() {
  const locks = store.state?.locks ?? [];
  const diffSummary = store.memory?.diffSummary || '';
  const diffs = store.diffs ?? [];

  return `
    <div class="card">
      <div class="card-title">
        <span style="display:inline-flex;align-items:center;gap:6px">${lucideIcon('lock')} Aktif Kilitler (${locks.length})</span>
      </div>
      ${
        locks.length
          ? locks
              .map(
                (l) => `
          <div class="list-item">
            <div style="min-width:0">
              <div class="mono-text" style="font-size:12px">${escapeHtml(l.file)}</div>
              <div class="muted-sub">Tutan: ${escapeHtml(agentDisplay(l.agent))}</div>
            </div>
            <button type="button" class="sub-chip" data-unlock-file="${escapeHtml(l.file)}">Kilidi Aç</button>
          </div>
        `,
              )
              .join('')
          : '<div class="card-desc">Aktif dosya kilidi yok.</div>'
      }
    </div>

    <div class="card">
      <div class="card-title"><span>Çalışma Ağacı (Git Diff)</span></div>
      <pre class="mono-box">${escapeHtml(diffSummary || 'Temiz çalışma ağacı (değişiklik yok).')}</pre>
    </div>

    ${
      diffs.length
        ? `<div class="card">
            <div class="card-title"><span>Son Ölçülen Diff Kayıtları</span></div>
            ${diffs
              .slice(-8)
              .reverse()
              .map(
                (d) => `
              <div class="list-item">
                <span class="mono-text" style="font-size:12px;overflow:hidden;text-overflow:ellipsis">${escapeHtml(d.file)}</span>
                <span style="font-size:11.5px;flex-shrink:0"><span style="color:var(--good)">+${d.added}</span> <span style="color:var(--bad)">-${d.removed}</span></span>
              </div>
            `,
              )
              .join('')}
          </div>`
        : ''
    }
  `;
}

function renderFilesTab() {
  const files = store.treeFiles ?? [];
  const filter = (document.getElementById('files-filter-input')?.value || '').trim().toLowerCase();
  const visible = filter ? files.filter((f) => f.toLowerCase().includes(filter)) : files;
  const preview = store.previewFile;

  return `
    <div class="card">
      <div class="card-title">
        <span>Proje Dosyaları (${visible.length})</span>
        <button type="button" class="sub-chip" id="btn-refresh-tree">Yenile</button>
      </div>
      <div class="custom-searchbar">
        ${lucideIcon('search')}
        <input id="files-filter-input" placeholder="Dosya ara..." value="${escapeHtml(filter)}" autocomplete="off" />
        ${filter ? '<button type="button" class="custom-searchbar-clear" data-clear-input="files-filter-input">×</button>' : ''}
      </div>
      <div class="file-tree-list">
        ${
          visible.length
            ? visible
                .slice(0, 160)
                .map(
                  (f) => `
              <button type="button" class="list-item file-row${preview?.path === f ? ' active' : ''}" data-preview-file="${escapeHtml(f)}">
                <span class="mono-text">${escapeHtml(f)}</span>
              </button>
            `,
                )
                .join('')
            : '<div class="card-desc">Dosya listesi yüklenmedi veya eşleşme yok.</div>'
        }
      </div>
    </div>

    ${
      preview
        ? `<div class="card">
            <div class="card-title">
              <span class="mono-text" style="text-transform:none">${escapeHtml(preview.path)}</span>
              <div style="display:flex;gap:6px">
                <button type="button" class="sub-chip" data-copy-encoded="${encodeURIComponent(preview.content || '')}">Kopyala</button>
                <button type="button" class="sub-chip" id="btn-close-file-preview">Kapat</button>
              </div>
            </div>
            <pre class="mono-box">${escapeHtml(preview.content || '')}</pre>
          </div>`
        : ''
    }
  `;
}

export function renderRightPanel() {
  const panel = document.getElementById('right-panel');
  const body = document.getElementById('right-panel-body');
  const toggleBtn = document.getElementById('btn-right-toggle');
  if (!panel || !body) return;

  panel.setAttribute('aria-hidden', store.rightPanelOpen ? 'false' : 'true');
  panel.classList.toggle('is-open', Boolean(store.rightPanelOpen));
  if (toggleBtn) {
    toggleBtn.setAttribute('aria-expanded', store.rightPanelOpen ? 'true' : 'false');
    toggleBtn.classList.toggle('active', Boolean(store.rightPanelOpen));
  }

  const tab = store.rightTab || 'live';
  document.querySelectorAll('.rp-tab[data-rp-tab]').forEach((el) => {
    el.classList.toggle('active', el.dataset.rpTab === tab);
  });

  if (!store.rightPanelOpen) return;

  if (tab === 'memory') {
    body.innerHTML = renderMemoryTab();
    return;
  }
  if (tab === 'locks') {
    body.innerHTML = renderLocksTab();
    return;
  }
  if (tab === 'files') {
    body.innerHTML = renderFilesTab();
    return;
  }
  body.innerHTML = renderLiveTab();
}

function getAgentMcpSnippet(agentSlug) {
  const mcp = store.mcpSetup;
  const key = AGENT_MCP_KEY_MAP[agentSlug] || 'antigravity';
  if (key === 'codex') return { path: mcp?.codex?.configPath || '~/.codex/config.toml', text: mcp?.codex?.toml || '' };
  if (key === 'claudeCode') return { path: mcp?.claudeCode?.configPath || 'Terminal komutu', text: mcp?.claudeCode?.command || '' };
  return {
    path: mcp?.[key]?.configPath || 'MCP yapılandırma dosyası',
    text: JSON.stringify(mcp?.[key]?.json || {}, null, 2),
  };
}

function renderAgentsView() {
  const ol = store.ollama;
  const allAgents = [
    ...runnableAgents().map((a) => ({ ...a, _badge: 'Aktif', _tone: 'good' })),
    ...mcpIdeAgents().map((a) => ({ ...a, _badge: 'MCP', _tone: 'accent' })),
    ...unconfiguredAgents().map((a) => ({ ...a, _badge: 'Pasif', _tone: 'dim' })),
  ];

  const rowsHtml = allAgents.length
    ? allAgents
        .map((a) => {
          const isExpanded = store.expandedAgentsCard === a.agent;
          const pref = store.prefs?.[a.agent] || {};
          const provider = AGENT_API_PROVIDER_MAP[a.agent] || a.agent;
          const configuredKey = (store.apiKeys ?? []).find((k) => k.provider === provider && k.configured);
          const sub =
            a.capability === 'runnable'
              ? `${a.transport}${a.selectedModel || a.defaultModel ? ` · ${a.selectedModel || a.defaultModel}` : ''}`
              : a.capability === 'mcp_ide'
                ? 'IDE MCP Oturumu'
                : a.reason || 'Bağlı değil';

          let drawerHtml = '';
          if (isExpanded) {
            if (a.capability === 'mcp_ide') {
              const snip = getAgentMcpSnippet(a.agent);
              drawerHtml = `
                <div class="agent-cfg-drawer">
                  <div class="muted-sub">MCP Dosyası: <code>${escapeHtml(snip.path)}</code></div>
                  <pre class="mono-box">${escapeHtml(snip.text || 'MCP yapılandırması yükleniyor...')}</pre>
                  <div style="display:flex;gap:8px;flex-wrap:wrap">
                    <button type="button" class="btn" data-copy-encoded="${encodeURIComponent(snip.text)}">MCP Yapılandırmasını Kopyala</button>
                    <button type="button" class="btn" data-open-agent="${escapeHtml(a.agent)}">Editörü Aç</button>
                  </div>
                  <div class="behavior-row">
                    <input type="text" class="field" data-agent-behavior="${escapeHtml(a.agent)}" placeholder="${escapeHtml(a.display)} için davranış notu..." value="${escapeHtml(pref.behavior || '')}" />
                    <button type="button" class="btn" data-save-agent-behavior="${escapeHtml(a.agent)}">Kaydet</button>
                  </div>
                </div>
              `;
            } else {
              drawerHtml = `
                <div class="agent-cfg-drawer">
                  <div class="row-between">
                    <span class="muted-sub">API Anahtarı (${escapeHtml(provider)})</span>
                    ${configuredKey ? `<span class="sub-chip active">${lucideIcon('check')} ${escapeHtml(configuredKey.masked)}</span>` : ''}
                  </div>
                  <div class="behavior-row">
                    <input type="password" class="field" id="api-key-input" data-agent-apikey-input="${escapeHtml(provider)}" placeholder="${escapeHtml(a.display)} API anahtarı (silmek için boş kaydet)" />
                    <button type="button" class="btn btn-primary" data-save-agent-apikey="${escapeHtml(provider)}">Anahtarı Kaydet</button>
                  </div>
                  <div class="behavior-row">
                    <input type="text" class="field" data-agent-behavior="${escapeHtml(a.agent)}" placeholder="${escapeHtml(a.display)} için davranış notu..." value="${escapeHtml(pref.behavior || '')}" />
                    <button type="button" class="btn" data-save-agent-behavior="${escapeHtml(a.agent)}">Notu Kaydet</button>
                  </div>
                </div>
              `;
            }
          }

          return `
            <div class="agent-clean-card${isExpanded ? ' is-expanded' : ''}">
              <div class="agent-clean-row">
                <div style="display:flex;align-items:center;gap:10px;min-width:0">
                  <img class="agent-icon" src="${agentIconPath(a.agent)}" alt="" />
                  <div style="min-width:0">
                    <div style="font-weight:600;font-size:13.5px">${escapeHtml(a.display)}</div>
                    <div class="muted-sub">${escapeHtml(sub)}</div>
                  </div>
                </div>
                <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
                  <span class="agent-badge is-${a._tone}">${escapeHtml(a._badge)}</span>
                  <button type="button" class="sub-chip${isExpanded ? ' active' : ''}" data-agent-cfg="${escapeHtml(a.agent)}">${isExpanded ? 'Kapat' : 'Ayarla'}</button>
                </div>
              </div>
              ${drawerHtml}
            </div>
          `;
        })
        .join('')
    : '<div class="card"><div class="card-desc">Ajan kataloğu yükleniyor...</div></div>';

  const olModel = ol?.recommendedModel || 'qwen2.5-coder:3b';
  const olStatus = ol?.running ? 'Çalışıyor' : ol?.installed ? 'Kurulu (servis kapalı)' : 'Kurulu değil';

  return `
    <div class="agents-clean-wrap">
      <div class="agents-clean-list">
        ${rowsHtml}
      </div>

      <div class="card ollama-strip">
        <div class="row-between" style="flex-wrap:wrap;gap:10px">
          <div style="display:flex;align-items:center;gap:10px;min-width:0">
            <img class="agent-icon" src="/icons/ollama.png" alt="" />
            <div>
              <div style="font-weight:600;font-size:13px">Yerel Ollama · ${escapeHtml(olStatus)}</div>
              <div class="muted-sub">${ol?.totalRamGb || '?'} GB RAM · Önerilen: <code>${escapeHtml(olModel)}</code></div>
            </div>
          </div>
          ${
            ol?.installed
              ? `<button type="button" class="btn" id="btn-pull-ollama" data-model="${escapeHtml(olModel)}">${escapeHtml(olModel)} İndir</button>`
              : `<a class="btn" href="${escapeHtml(ol?.installUrl || 'https://ollama.com/download')}" target="_blank" rel="noreferrer">Ollama İndir</a>`
          }
        </div>
      </div>
    </div>
  `;
}

function buildSettingsRows() {
  const usage = store.usage || { resetInMs: 0, items: [] };
  const stats = store.profileStats || usage.profileStats || { record5hTokens: 0, record5hAt: 0 };
  const activeAgents = store.state?.agents ?? [];
  const recordDate = stats.record5hAt
    ? new Date(stats.record5hAt).toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'short' })
    : 'Henüz kayıt yok';

  const curLang =
    document.getElementById('lang-select')?.dataset?.value ||
    store.state?.lang ||
    'tr';
  const skills = store.skills ?? [];
  const curSkillAgent = document.getElementById('skill-agent-select')?.dataset?.value ?? '';
  const skillAgentOptions = [
    { value: '', label: 'Tüm Ajanlar' },
    ...store.catalog.map((a) => ({ value: a.agent, label: a.display })),
  ];
  const git = store.gitStatus || {};
  const pplxKey = (store.apiKeys ?? []).find((k) => k.provider === 'perplexity');

  return [
    // Account / Profile
    {
      cat: 'account',
      catLabel: 'Hesap & Profil',
      title: '5 Saatlik Limit Rekoru & Özet',
      keywords: 'profil hesap limit rekor token istatistik kullanım oturum',
      html: `
        <div class="card">
          <div class="card-title"><span>Profil & Oturum Özeti</span><span class="agent-badge">${escapeHtml(store.project || 'Masiva Labs')}</span></div>
          <div class="stats-grid">
            <div class="stat-box">
              <div class="stat-val">${escapeHtml(formatCompact(stats.record5hTokens || 0))}</div>
              <div class="stat-lbl">5s Rekor Token</div>
            </div>
            <div class="stat-box">
              <div class="stat-val">${escapeHtml(recordDate)}</div>
              <div class="stat-lbl">Rekor Tarihi</div>
            </div>
            <div class="stat-box">
              <div class="stat-val">${activeAgents.filter((a) => a.status !== 'offline').length}</div>
              <div class="stat-lbl">Çevrimiçi Ajan</div>
            </div>
          </div>
        </div>
      `,
    },
    {
      cat: 'account',
      catLabel: 'Hesap & Profil',
      title: 'Aktif Kullanım Barları',
      keywords: 'kullanım bar kota yüzde 5 saatlik pencere sıfırlanma',
      html: `
        <div class="card">
          <div class="card-title">
            <span>5 Saatlik Kullanım Penceresi</span>
            <span class="muted-sub">Sıfırlanma: ${escapeHtml(formatDurationMs(usage.resetInMs))}</span>
          </div>
          ${renderUsageBars(usage)}
        </div>
      `,
    },

    // Appearance
    {
      cat: 'appearance',
      catLabel: 'Görünüm',
      title: 'Tema Seçimi',
      keywords: 'tema dark light midnight forest nord obsidian oled görünüm renk',
      html: `
        <div class="settings-row">
          <div class="settings-row-info">
            <div class="settings-row-title">Arayüz Teması</div>
            <div class="card-desc">6 farklı koyu ve aydınlık palet arasından seçim yapın.</div>
          </div>
          <div class="settings-row-ctrl">
            ${renderCustomSelect({
              id: 'theme-select',
              name: 'uiTheme',
              value: store.theme || 'dark',
              options: THEMES,
              placeholder: 'Tema seç...',
            })}
          </div>
        </div>
      `,
    },
    {
      cat: 'appearance',
      catLabel: 'Görünüm',
      title: 'Vurgu Rengi (Accent)',
      keywords: 'vurgu rengi accent safir zümrüt menekşe kehribar gül renk',
      html: `
        <div class="settings-row-stack">
          <div class="settings-row-info">
            <div class="settings-row-title">Vurgu Rengi</div>
            <div class="card-desc">Aktif durumlar, kaydırıcılar ve görev ışığı için vurgu tonu.</div>
          </div>
          <div class="swatch-grid">
            ${ACCENT_SWATCHES.map(
              (sw) => `
              <button
                type="button"
                class="accent-swatch${store.accent === sw.id ? ' active' : ''}"
                data-set-accent="${sw.id}"
                title="${escapeHtml(sw.label)}"
              >
                <span class="swatch-dot" style="background:${sw.color}"></span>
                <span>${escapeHtml(sw.label)}</span>
              </button>
            `,
            ).join('')}
          </div>
        </div>
      `,
    },
    {
      cat: 'appearance',
      catLabel: 'Görünüm',
      title: 'Yazı Tipi (Font)',
      keywords: 'font yazı tipi inter system jetbrains mono serif tipografi',
      html: `
        <div class="settings-row">
          <div class="settings-row-info">
            <div class="settings-row-title">Yazı Tipi</div>
            <div class="card-desc">Sohbet ve panel okunabilirliği için tercih edilen font ailesi.</div>
          </div>
          <div class="settings-row-ctrl">
            ${renderCustomSelect({
              id: 'font-select',
              name: 'uiFont',
              value: store.font || 'inter',
              options: FONTS,
              placeholder: 'Font seç...',
            })}
          </div>
        </div>
      `,
    },
    {
      cat: 'appearance',
      catLabel: 'Görünüm',
      title: 'Görev Modu Animasyonu',
      keywords: 'animasyon görev modu task halo efekt görsel',
      html: `
        <div class="settings-row">
          <div class="settings-row-info">
            <div class="settings-row-title">Görev Modu Animasyonu</div>
            <div class="card-desc">Task modunda ajanlar çalışırken çevre ışığı ve geçiş efektlerini göster.</div>
          </div>
          <label class="switch-toggle">
            <input type="checkbox" id="toggle-task-anim" ${store.taskAnim !== false ? 'checked' : ''} />
          </label>
        </div>
      `,
    },

    // General & Language
    {
      cat: 'general',
      catLabel: 'Genel & Dil',
      title: 'Proje Dili',
      keywords: 'dil language türkçe english deutsch français español genel',
      html: `
        <div class="settings-row">
          <div class="settings-row-info">
            <div class="settings-row-title">Proje Dili</div>
            <div class="card-desc">Ajan yanıtları ve ortak proje kuralları için varsayılan dil.</div>
          </div>
          <div class="settings-row-ctrl">
            ${renderCustomSelect({
              id: 'lang-select',
              name: 'uiLang',
              value: curLang,
              options: LANG_OPTIONS,
              placeholder: 'Dil seç...',
            })}
            <button type="button" class="btn" id="btn-save-lang">Kaydet</button>
          </div>
        </div>
      `,
    },
    {
      cat: 'general',
      catLabel: 'Genel & Dil',
      title: 'Kısa Ajan Özetleri (2–3 Satır)',
      keywords: 'özet kısa concise ajan çıktı 2-3 satır okunabilirlik',
      html: `
        <div class="settings-row">
          <div class="settings-row-info">
            <div class="settings-row-title">Kısa Ajan Özetleri (2–3 Satır)</div>
            <div class="card-desc">Uzun ajan yanıtlarını sohbet akışında 2–3 satırlık özet kartlar halinde göster, detay için aç.</div>
          </div>
          <label class="switch-toggle">
            <input type="checkbox" id="toggle-concise" ${store.conciseMode !== false ? 'checked' : ''} />
          </label>
        </div>
      `,
    },
    {
      cat: 'general',
      catLabel: 'Genel & Dil',
      title: 'Sağ Panel Varsayılan Açık',
      keywords: 'sağ panel canlı hafıza kilitler varsayılan düzen layout',
      html: `
        <div class="settings-row">
          <div class="settings-row-info">
            <div class="settings-row-title">Sağ Paneli Açık Tut</div>
            <div class="card-desc">Canlı ajan akışı ve 5 saatlik limit sayacı panelini varsayılan olarak açık tut.</div>
          </div>
          <label class="switch-toggle">
            <input type="checkbox" id="toggle-right-default" ${store.rightPanelOpen ? 'checked' : ''} />
          </label>
        </div>
      `,
    },

    // Skills
    {
      cat: 'skills',
      catLabel: 'Yetenekler',
      title: 'Yüklü Yetenekler (Skills)',
      keywords: 'yetenek skill workspace talimat .agents/skills',
      html: `
        <div class="settings-row-stack">
          <div class="settings-row-info">
            <div class="settings-row-title">Yüklü Yetenekler (${skills.length})</div>
            <div class="card-desc">.agents/skills klasöründe tanımlı ajan yetenekleri.</div>
          </div>
          <div class="skills-list">
            ${
              skills.length
                ? skills
                    .map(
                      (s) => `
                  <div class="list-item">
                    <div style="min-width:0">
                      <div style="font-weight:600;font-size:13px">${escapeHtml(s.name)}</div>
                      <div class="muted-sub">${escapeHtml(s.description)}</div>
                    </div>
                    <div style="display:flex;align-items:center;gap:5px;flex-shrink:0">
                      ${s.agent ? `<span class="sub-chip">${escapeHtml(agentDisplay(s.agent))}</span>` : ''}
                      <span class="agent-badge">${escapeHtml(s.source)}</span>
                    </div>
                  </div>
                `,
                    )
                    .join('')
                : '<div class="card-desc">Henüz özel yetenek bulunamadı.</div>'
            }
          </div>
        </div>
      `,
    },
    {
      cat: 'skills',
      catLabel: 'Yetenekler',
      title: 'Yeni Yetenek Oluştur',
      keywords: 'yeni yetenek ekle oluştur skill.md talimat',
      html: `
        <div class="settings-row-stack">
          <div class="settings-row-info">
            <div class="settings-row-title">Yeni Yetenek Oluştur (.agents/skills)</div>
            <div class="card-desc">Ajanların okuyabileceği kalıcı talimat paketi ekleyin.</div>
          </div>
          <input id="skill-name-input" class="field" maxlength="20" placeholder="Yetenek adı (1-20 karakter)..." />
          <input id="skill-desc-input" class="field" placeholder="Kısa açıklama..." />
          ${renderCustomSelect({
            id: 'skill-agent-select',
            name: 'skill-agent',
            value: curSkillAgent,
            options: skillAgentOptions,
            placeholder: 'Hedef ajan...',
          })}
          <textarea id="skill-instructions-input" class="field" rows="3" placeholder="Talimatlar (SKILL.md içeriği)..."></textarea>
          <div><button type="button" class="btn btn-primary" id="btn-create-skill">Yetenek Oluştur</button></div>
        </div>
      `,
    },

    // Git & Connections
    {
      cat: 'git',
      catLabel: 'Git & Bağlantılar',
      title: 'Git Durumu & Remote',
      keywords: 'git github branch remote repo commit push bağlantı',
      html: `
        <div class="settings-row-stack">
          <div class="row-between">
            <div class="settings-row-info">
              <div class="settings-row-title">Git Durumu</div>
              <div class="card-desc">Remote: <code>${escapeHtml(git.remote || 'Tanımlı değil')}</code> · Değişiklikler: <strong>${git.changes ?? 0}</strong> · Auth: <strong>${git.hasGithubAuth ? escapeHtml(git.githubUser || git.authSource) : 'Bağlı değil'}</strong></div>
            </div>
            <span class="agent-badge">${git.isRepo ? escapeHtml(git.branch || 'main') : 'Repo Yok'}</span>
          </div>
          ${
            Array.isArray(git.files) && git.files.length
              ? `<pre class="mono-box">${escapeHtml(git.files.join('\n'))}</pre>`
              : ''
          }
          <div class="row-gap">
            <input id="git-remote-input" class="field" placeholder="https://github.com/user/repo.git" value="${escapeHtml(git.remote || '')}" />
            <button type="button" class="btn" id="btn-git-remote">Remote Ayarla</button>
          </div>
        </div>
      `,
    },
    {
      cat: 'git',
      catLabel: 'Git & Bağlantılar',
      title: 'Commit, Push & GitHub Token',
      keywords: 'commit push github token auth çıkış',
      html: `
        <div class="settings-row-stack">
          <div class="settings-row-info">
            <div class="settings-row-title">Commit & Push</div>
            <div class="card-desc">Değişiklikleri yerel commit veya GitHub push olarak gönderin.</div>
          </div>
          <input id="git-commit-msg" class="field" placeholder="Commit mesajı..." />
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button type="button" class="btn" id="btn-git-commit">Commit</button>
            <button type="button" class="btn btn-primary" id="btn-git-push">Commit & Push</button>
          </div>
          <div class="row-gap" style="margin-top:6px">
            <input id="git-token-input" type="password" class="field" placeholder="GitHub Token (opsiyonel)" />
            <input id="git-user-input" class="field" placeholder="GitHub Kullanıcı Adı" value="${escapeHtml(git.userName || '')}" />
            <div style="display:flex;gap:8px">
              <button type="button" class="btn" id="btn-git-auth">GitHub Bağla</button>
              ${git.hasGithubAuth ? '<button type="button" class="btn" id="btn-git-logout">Çıkış</button>' : ''}
            </div>
          </div>
        </div>
      `,
    },
    {
      cat: 'git',
      catLabel: 'Git & Bağlantılar',
      title: 'Perplexity API Anahtarı',
      keywords: 'perplexity api key web araştırma sonar',
      html: `
        <div class="settings-row-stack">
          <div class="row-between">
            <div class="settings-row-info">
              <div class="settings-row-title">Perplexity Araştırma Anahtarı</div>
              <div class="card-desc">Ajanların canlı web araştırması isteklerini otomatik yanıtlamak için API anahtarı.</div>
            </div>
            ${pplxKey?.configured ? `<span class="sub-chip active">${escapeHtml(pplxKey.masked)}</span>` : ''}
          </div>
          <div style="display:flex;gap:8px">
            <input id="perplexity-key-input" type="password" class="field" placeholder="pplx-... (temizlemek için boş kaydet)" />
            <button type="button" class="btn btn-primary" id="btn-save-perplexity">Kaydet</button>
          </div>
        </div>
      `,
    },

    // Shortcuts
    {
      cat: 'shortcuts',
      catLabel: 'Kısayollar',
      title: 'Klavye Kısayolları',
      keywords: 'kısayol klavye shortcut ctrl+f ctrl+, enter shift+enter esc',
      html: `
        <div class="settings-row">
          <div class="settings-row-info">
            <div class="settings-row-title">Ayarlar penceresini aç / kapat</div>
            <div class="card-desc">Herhangi bir ekrandan Ayarlar penceresini hızla açar.</div>
          </div>
          <div class="settings-row-ctrl"><span class="kbd-pill">Ctrl+,</span></div>
        </div>
        <div class="settings-row">
          <div class="settings-row-info">
            <div class="settings-row-title">Hızlı arama menüsü</div>
            <div class="card-desc">Sohbet, proje, ayar ve ajanları tahminli kutuyla anında bulur.</div>
          </div>
          <div class="settings-row-ctrl"><span class="kbd-pill">Ctrl+F</span></div>
        </div>
        <div class="settings-row">
          <div class="settings-row-info">
            <div class="settings-row-title">Mesaj gönder / Yeni satır</div>
            <div class="card-desc">Metin kutusunda gönderim ve alt satır geçişleri.</div>
          </div>
          <div class="settings-row-ctrl"><span class="kbd-pill">Enter</span><span class="kbd-pill">Shift+Enter</span></div>
        </div>
        <div class="settings-row">
          <div class="settings-row-info">
            <div class="settings-row-title">Açık pencereyi kapat</div>
            <div class="card-desc">Ayarlar, arama veya açılır menüleri anında kapatır.</div>
          </div>
          <div class="settings-row-ctrl"><span class="kbd-pill">Esc</span></div>
        </div>
      `,
    },
  ];
}

function renderClaudeSettingsView() {
  const activeTab = store.settingsTab || 'appearance';
  const query = (store.settingsQuery || '').trim();
  const qNorm = query.toLocaleLowerCase('tr');
  const allRows = buildSettingsRows();

  const visibleRows = qNorm
    ? allRows.filter((r) =>
        `${r.title} ${r.catLabel} ${r.keywords}`.toLocaleLowerCase('tr').includes(qNorm),
      )
    : allRows.filter((r) => r.cat === activeTab);

  const activeCatObj = SETTINGS_CATEGORIES.find((c) => c.id === activeTab);
  const railHtml = SETTINGS_CATEGORIES.map((c, idx) => {
    const sep = idx === 1 || idx === 4 ? '<div class="settings-sep"></div>' : '';
    return `
      ${sep}
      <button
        type="button"
        class="settings-nav-item${!qNorm && activeTab === c.id ? ' active' : ''}"
        data-settings-tab="${c.id}"
      >
        ${lucideIcon(c.icon)}
        <span>${escapeHtml(c.label)}</span>
      </button>
    `;
  }).join('');

  const paneTitle = qNorm ? `Arama Sonuçları (${visibleRows.length})` : activeCatObj?.label || 'Ayarlar';
  const contentHtml = visibleRows.length
    ? visibleRows
        .map((r) =>
          qNorm
            ? `<div class="settings-search-hit"><div class="settings-hit-cat" style="font-size:11px;color:#8e8d87;margin-top:10px">${escapeHtml(r.catLabel)}</div>${r.html}</div>`
            : r.html,
        )
        .join('')
    : '<div class="settings-row"><div class="settings-row-info"><div class="settings-row-title">Eşleşen ayar bulunamadı.</div></div></div>';

  return `
    <div class="settings-shell">
      <aside class="settings-rail">
        <div class="custom-searchbar">
          ${lucideIcon('search')}
          <input
            id="settings-search-input"
            placeholder="Ara"
            value="${escapeHtml(query)}"
            autocomplete="off"
          />
          ${query ? '<button type="button" class="custom-searchbar-clear" data-clear-input="settings-search-input">×</button>' : ''}
        </div>
        <nav class="settings-nav" aria-label="Ayar kategorileri">
          ${railHtml}
        </nav>
      </aside>
      <div class="settings-pane">
        <h3 class="settings-pane-title">${escapeHtml(paneTitle)}</h3>
        ${contentHtml}
      </div>
    </div>
  `;
}

export function renderViewOverlay(onCanvasSend) {
  const overlay = document.getElementById('view-overlay');
  const titleEl = document.getElementById('view-title');
  const body = document.getElementById('view-body');
  if (!overlay || !titleEl || !body) return;

  const viewCard = overlay.querySelector('.view-card');
  const view = store.activeView;
  if (!view) {
    overlay.setAttribute('aria-hidden', 'true');
    overlay.classList.remove('is-open');
    viewCard?.classList.remove('is-settings');
    if (cleanupCanvas) {
      cleanupCanvas();
      cleanupCanvas = null;
    }
    if (body.dataset.mountedView === 'canvas') {
      delete body.dataset.mountedView;
      body.innerHTML = '';
    }
    return;
  }

  const isSettingsModal =
    view === 'settings' || view === 'profile' || view === 'customization';

  overlay.setAttribute('aria-hidden', 'false');
  overlay.classList.add('is-open');
  viewCard?.classList.toggle('is-settings', isSettingsModal);

  if (view === 'canvas') {
    titleEl.textContent = 'Çizim Tuvali (Canvas)';
    if (body.dataset.mountedView === 'canvas' && body.querySelector('.canvas-studio')) {
      return;
    }
    if (cleanupCanvas) {
      cleanupCanvas();
      cleanupCanvas = null;
    }
    body.dataset.mountedView = 'canvas';
    cleanupCanvas = mountCanvas(body, onCanvasSend);
    return;
  }

  if (cleanupCanvas) {
    cleanupCanvas();
    cleanupCanvas = null;
  }
  delete body.dataset.mountedView;

  if (view === 'agents') {
    titleEl.textContent = 'Ajanlar';
    body.innerHTML = renderAgentsView();
    return;
  }

  if (isSettingsModal) {
    titleEl.textContent = 'Ayarlar';
    body.innerHTML = renderClaudeSettingsView();
  }
}
