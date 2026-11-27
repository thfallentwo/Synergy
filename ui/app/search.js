import { escapeHtml } from './markdown.js';
import { lucideIcon } from './panels.js';
import { store } from './state.js';

const SETTING_SEARCH_INDEX = [
  { tab: 'appearance', title: 'Tema & Görünüm', sub: '6 tema (Obsidian, Light, Midnight, Forest, Nord, OLED)', keywords: 'tema theme dark light midnight forest nord oled görünüm', icon: 'palette' },
  { tab: 'appearance', title: 'Yazı Tipi (Font)', sub: 'Inter, System Sans, JetBrains Mono, Editorial Serif', keywords: 'font yazı tipi inter system mono serif', icon: 'palette' },
  { tab: 'appearance', title: 'Vurgu Rengi (Accent)', sub: 'Safir, Zümrüt, Menekşe, Kehribar, Gül', keywords: 'vurgu rengi accent renk swatch', icon: 'palette' },
  { tab: 'account', title: 'Profil & Limit Sayacı', sub: '5 saatlik kullanım rekoru ve aktif kota barları', keywords: 'profil hesap limit kota token rekor kullanım', icon: 'user' },
  { tab: 'general', title: 'Proje Dili', sub: 'Türkçe, English, Deutsch, Français, Español, 日本語', keywords: 'dil language türkçe english genel', icon: 'sliders' },
  { tab: 'general', title: 'Özet Modu (2–3 Satır)', sub: 'Kısa ajan özetlerini aç / kapat', keywords: 'özet kısa concise ajan', icon: 'sliders' },
  { tab: 'skills', title: 'Yetenekler (Skills)', sub: 'Workspace yetenekleri ve yeni skill ekleme', keywords: 'yetenek skills skill.md talimat', icon: 'cpu' },
  { tab: 'git', title: 'Git & GitHub', sub: 'Remote URL, Commit, Push ve GitHub bağlantısı', keywords: 'git github commit push remote repo', icon: 'git' },
  { tab: 'git', title: 'Perplexity Araştırma Anahtarı', sub: 'Canlı web araştırması için API anahtarı', keywords: 'perplexity api key araştırma web', icon: 'git' },
  { tab: 'shortcuts', title: 'Klavye Kısayolları', sub: 'Ctrl+,, Ctrl+F, Enter, Shift+Enter', keywords: 'kısayol klavye shortcut ctrl', icon: 'keyboard' },
];

function norm(str) {
  return String(str || '').toLocaleLowerCase('tr').trim();
}

function matchesQuery(haystack, tokens) {
  if (!tokens.length) return true;
  const h = norm(haystack);
  return tokens.every((tk) => h.includes(tk));
}

export function buildSearchItems(query = '') {
  const q = norm(query);
  const tokens = q ? q.split(/\s+/).filter(Boolean) : [];
  const items = [];

  const chats = store.state?.chats ?? [];
  const chatLimit = tokens.length ? 8 : 4;
  let chatAdded = 0;
  for (const c of chats) {
    if (chatAdded >= chatLimit) break;
    const title = c.title || `Sohbet #${c.id}`;
    const sub = c.id === store.state?.activeChatId ? 'Aktif sohbet' : `Sohbet #${c.id}`;
    if (matchesQuery(`${title} ${sub}`, tokens)) {
      items.push({
        kind: 'chat',
        id: c.id,
        title,
        sub,
        category: 'Sohbetler',
        icon: 'chat',
      });
      chatAdded += 1;
    }
  }

  const projects = (store.projects ?? []).filter((p) => !p.archived);
  const projLimit = tokens.length ? 6 : 3;
  let projAdded = 0;
  for (const p of projects) {
    if (projAdded >= projLimit) break;
    const title = p.name || p.dir || 'Proje';
    const sub = p.dir || '';
    if (matchesQuery(`${title} ${sub}`, tokens)) {
      items.push({
        kind: 'project',
        dir: p.dir,
        title,
        sub,
        category: 'Projeler',
        icon: 'folder',
      });
      projAdded += 1;
    }
  }

  const agents = store.catalog ?? [];
  const agentLimit = tokens.length ? 8 : 4;
  let agentAdded = 0;
  for (const a of agents) {
    if (agentAdded >= agentLimit) break;
    const title = a.display || a.agent;
    const sub =
      a.capability === 'runnable'
        ? `Aktif · ${a.selectedModel || a.defaultModel || a.transport}`
        : a.capability === 'mcp_ide'
          ? 'IDE MCP'
          : 'Pasif';
    if (matchesQuery(`${title} ${a.agent} ${sub}`, tokens)) {
      items.push({
        kind: 'agent',
        agent: a.agent,
        title,
        sub,
        category: 'Ajanlar',
        icon: 'cpu',
      });
      agentAdded += 1;
    }
  }

  const settingLimit = tokens.length ? 10 : 5;
  let settingAdded = 0;
  for (const s of SETTING_SEARCH_INDEX) {
    if (settingAdded >= settingLimit) break;
    if (matchesQuery(`${s.title} ${s.sub} ${s.keywords}`, tokens)) {
      items.push({
        kind: 'setting',
        tab: s.tab,
        title: s.title,
        sub: s.sub,
        category: 'Ayarlar',
        icon: s.icon,
      });
      settingAdded += 1;
    }
  }

  return items;
}

export function renderSearchOverlay() {
  const overlay = document.getElementById('search-overlay');
  const resultsEl = document.getElementById('search-results');
  if (!overlay || !resultsEl) return;

  const isOpen = Boolean(store.searchOpen);
  overlay.setAttribute('aria-hidden', isOpen ? 'false' : 'true');
  overlay.classList.toggle('is-open', isOpen);
  if (!isOpen) return;

  const items = buildSearchItems(store.searchQuery || '');
  if (!items.length) {
    store.searchIdx = 0;
    resultsEl.innerHTML = '<div class="search-empty">Eşleşen sohbet, proje, ajan veya ayar bulunamadı.</div>';
    return;
  }

  if (store.searchIdx < 0) store.searchIdx = 0;
  if (store.searchIdx >= items.length) store.searchIdx = items.length - 1;

  let lastCategory = '';
  const html = items
    .map((item, idx) => {
      const catHead =
        item.category !== lastCategory
          ? `<div class="search-group-title">${escapeHtml(item.category)}</div>`
          : '';
      lastCategory = item.category;

      const dataAttr =
        item.kind === 'chat'
          ? `data-search-chat="${escapeHtml(item.id)}"`
          : item.kind === 'project'
            ? `data-search-project="${escapeHtml(item.dir)}"`
            : item.kind === 'agent'
              ? `data-search-agent="${escapeHtml(item.agent)}"`
              : `data-search-setting="${escapeHtml(item.tab)}"`;

      return `
        ${catHead}
        <button
          type="button"
          class="search-item${idx === store.searchIdx ? ' active' : ''}"
          data-search-idx="${idx}"
          data-search-kind="${escapeHtml(item.kind)}"
          ${dataAttr}
        >
          <span class="search-item-ico">${lucideIcon(item.icon)}</span>
          <span class="search-item-body">
            <span class="search-item-title">${escapeHtml(item.title)}</span>
            <span class="search-item-sub">${escapeHtml(item.sub)}</span>
          </span>
        </button>
      `;
    })
    .join('');

  resultsEl.innerHTML = html;
}
