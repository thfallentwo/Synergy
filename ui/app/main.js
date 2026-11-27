import { apiGet, apiPost, connectSse } from './api.js';
import { wireCustomSelects } from './customSelect.js';
import { renderRightPanel, renderViewOverlay } from './panels.js';
import {
  expandedMessages,
  isActiveChatLocked,
  renderAll,
  renderComposerState,
  renderMessages,
  renderPopovers,
  renderSidebar,
  renderTopbar,
  setCanvasSendHandler,
  showToast,
} from './render.js';
import { buildSearchItems, renderSearchOverlay } from './search.js';
import {
  EFFORT_LABELS,
  EFFORT_STOPS,
  getChatMode,
  lockChatMode,
  mcpIdeAgents,
  persistUiPrefs,
  store,
  syncSelectedAgents,
} from './state.js';

function restoreLocalPreferences() {
  try {
    const savedTheme = localStorage.getItem('masiva-theme');
    if (savedTheme) store.theme = savedTheme;
    const savedAccent = localStorage.getItem('masiva-accent');
    if (savedAccent) store.accent = savedAccent;
    const savedFont = localStorage.getItem('masiva-font');
    if (savedFont) store.font = savedFont;

    const rawModes = localStorage.getItem('masiva-chat-modes');
    if (rawModes) {
      const parsed = JSON.parse(rawModes);
      if (parsed && typeof parsed === 'object') store.chatModes = parsed;
    }

    store.sidebarExpanded = localStorage.getItem('masiva-sidebar-expanded') === '1';
    store.rightPanelOpen = localStorage.getItem('masiva-right-open') === '1';
    const savedConcise = localStorage.getItem('masiva-concise');
    if (savedConcise !== null) store.conciseMode = savedConcise === '1';
  } catch {
    /* ignore storage failures */
  }
  persistUiPrefs();
}

function saveLayoutToggles() {
  try {
    localStorage.setItem('masiva-sidebar-expanded', store.sidebarExpanded ? '1' : '0');
    localStorage.setItem('masiva-right-open', store.rightPanelOpen ? '1' : '0');
  } catch {
    /* ignore */
  }
}

function applyTheme(theme) {
  store.theme = String(theme || 'dark');
  persistUiPrefs();
}

function autoResizePrompt(el) {
  if (!el) return;
  const prevHeight = el.getBoundingClientRect().height || 26;
  el.style.transition = 'none';
  el.style.height = 'auto';
  const nextHeight = Math.min(180, Math.max(26, el.scrollHeight));
  el.style.height = `${prevHeight}px`;
  void el.offsetHeight;
  el.style.transition = '';
  el.style.height = `${nextHeight}px`;
}

function ensureActiveChatLockFromEvents() {
  const activeId = store.state?.activeChatId;
  if (activeId == null) return;
  const locked = getChatMode(activeId);
  if (locked) {
    if (store.topMode !== locked) {
      store.topMode = locked === 'task' ? 'task' : 'direct';
      syncSelectedAgents();
    }
    return;
  }
  const hasConversation = (store.events ?? []).some((e) => e.type === 'human' || e.type === 'ask');
  if (hasConversation) {
    lockChatMode(activeId, store.topMode === 'task' ? 'task' : 'direct');
  }
}

async function refreshFast() {
  const [memRes, keysRes, skillsRes, treeRes, gitRes, usageRes, prefsRes] = await Promise.allSettled([
    apiGet('/api/memory'),
    apiGet('/api/settings/api-keys'),
    apiGet('/api/skills'),
    apiGet('/api/tree'),
    apiGet('/api/git/status'),
    apiGet('/api/usage'),
    apiGet('/api/agents/prefs'),
  ]);
  if (memRes.status === 'fulfilled') store.memory = memRes.value;
  if (keysRes.status === 'fulfilled') store.apiKeys = keysRes.value.keys ?? [];
  if (skillsRes.status === 'fulfilled') store.skills = skillsRes.value.skills ?? [];
  if (treeRes.status === 'fulfilled') store.treeFiles = treeRes.value.files ?? [];
  if (gitRes.status === 'fulfilled') store.gitStatus = gitRes.value;
  if (usageRes.status === 'fulfilled') {
    store.usage = usageRes.value;
    if (usageRes.value?.profileStats) store.profileStats = usageRes.value.profileStats;
  }
  if (prefsRes.status === 'fulfilled') {
    store.prefs = prefsRes.value.prefs ?? {};
    if (prefsRes.value?.profileStats) store.profileStats = prefsRes.value.profileStats;
  }
  renderAll();
}

async function refreshMetadata() {
  const [catRes, olRes, mcpRes] = await Promise.allSettled([
    apiGet('/api/agents/catalog'),
    apiGet('/api/ollama/status'),
    apiGet('/api/mcp/setup'),
  ]);
  if (catRes.status === 'fulfilled') {
    store.catalog = catRes.value.agents ?? [];
    syncSelectedAgents();
  }
  if (olRes.status === 'fulfilled') store.ollama = olRes.value;
  if (mcpRes.status === 'fulfilled') store.mcpSetup = mcpRes.value;
  await refreshFast();
}

async function handleCanvasSend(dataUrl) {
  if (!dataUrl) return;
  try {
    const res = await apiPost('/api/upload', { dataUrl });
    store.pendingImage = res.url;
    store.activeView = null;
    renderAll();
    showToast('Canvas çizimi sohbete eklendi');
    document.getElementById('prompt-input')?.focus();
  } catch (e) {
    showToast(e?.message || 'Canvas görseli yüklenemedi');
  }
}

async function copyText(text, label = 'Panoya kopyalandı') {
  try {
    await navigator.clipboard.writeText(text);
    showToast(label);
  } catch {
    showToast('Kopyalama izni reddedildi');
  }
}

function cycleMcpTarget() {
  const candidates = ['', ...mcpIdeAgents().map((a) => a.agent)];
  const idx = candidates.indexOf(store.mcpTarget);
  store.mcpTarget = candidates[(idx + 1) % candidates.length] || '';
  renderComposerState();
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Dosya okunamadı'));
    reader.readAsDataURL(file);
  });
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const res = String(reader.result || '');
      const comma = res.indexOf(',');
      resolve(comma >= 0 ? res.slice(comma + 1) : res);
    };
    reader.onerror = () => reject(new Error('Dosya okunamadı'));
    reader.readAsDataURL(file);
  });
}

async function submitPrompt() {
  const input = document.getElementById('prompt-input');
  let raw = input?.value?.trim() || '';
  if (store.pendingBundle) {
    const bundleNote = `[Yüklü Dosyalar: ${store.pendingBundle.bundleDir} (${store.pendingBundle.count} dosya)]`;
    raw = raw ? `${raw}\n\n${bundleNote}` : bundleNote;
  }
  if ((!raw && !store.pendingImage) || store.busy) return;

  const textToSend = raw || 'Ekli görseli incele.';
  const activeChatId = store.state?.activeChatId;

  if (/^\/(lock|unlock)\s+/i.test(textToSend) || /^\/meeting(?:\s|$)/i.test(textToSend) || /^@[a-z0-9_-]+/i.test(textToSend)) {
    if (activeChatId != null && !getChatMode(activeChatId)) {
      lockChatMode(activeChatId, store.topMode === 'task' ? 'task' : 'direct');
    }
    store.busy = true;
    renderTopbar();
    renderComposerState();
    try {
      const res = await apiPost('/api/message', {
        text: textToSend,
        image: store.pendingImage || undefined,
      });
      if (input) {
        input.value = '';
        autoResizePrompt(input);
      }
      store.pendingImage = null;
      store.pendingBundle = null;
      if (res.notice) showToast(res.notice);
    } catch (e) {
      showToast(e.message);
    } finally {
      store.busy = false;
      renderAll();
    }
    return;
  }

  if (!store.selectedAgents.length) {
    showToast('Önce sağ alttan çalıştırılabilir bir ajan seç veya bağla.');
    store.modelPopoverOpen = true;
    renderPopovers();
    return;
  }

  if (activeChatId != null && !getChatMode(activeChatId)) {
    lockChatMode(activeChatId, store.topMode === 'task' ? 'task' : 'direct');
  }

  store.busy = true;
  store.modelPopoverOpen = false;
  store.plusPopoverOpen = false;
  const attachedImg = store.pendingImage;
  renderTopbar();
  renderComposerState();
  renderPopovers();

  try {
    await apiPost('/api/message', {
      text: textToSend,
      image: attachedImg || undefined,
    });
    if (input) {
      input.value = '';
      autoResizePrompt(input);
    }
    store.pendingImage = null;
    store.pendingBundle = null;
    renderComposerState();

    const mode = store.topMode === 'direct' ? 'direct' : store.taskSubMode || 'code_review';
    const orcRes = await apiPost('/api/orchestrate', {
      mode,
      prompt: textToSend,
      agents: store.selectedAgents,
      allowWrite: store.topMode === 'task' ? store.allowWrite : false,
      mcpTarget:
        store.topMode === 'task' && mode === 'code_review' && store.mcpTarget
          ? store.mcpTarget
          : undefined,
      sync: true,
    });
    const [mem, usage] = await Promise.all([
      apiGet('/api/memory').catch(() => null),
      apiGet('/api/usage').catch(() => null),
    ]);
    if (mem) store.memory = mem;
    if (usage) {
      store.usage = usage;
      if (usage.profileStats) store.profileStats = usage.profileStats;
    }
    if (orcRes?.handoffTo) showToast(`Handoff gönderildi → ${orcRes.handoffTo}`);
  } catch (e) {
    showToast(e.message);
  } finally {
    store.busy = false;
    renderAll();
  }
}

async function updateAgentEffort(agent, effort) {
  const entry = store.catalog.find((a) => a.agent === agent);
  if (entry) entry.reasoningEffort = effort;
  renderComposerState();
  showToast(`Effort: ${EFFORT_LABELS[effort] || effort}`);
  apiPost('/api/agents/prefs', { agent, reasoningEffort: effort }).catch((e) =>
    showToast(e?.message || 'Effort kaydedilemedi'),
  );
}

async function executeSearchItem(item) {
  if (!item) return;
  store.searchOpen = false;
  renderSearchOverlay();
  const kind = item.kind || item.type;
  if (kind === 'chat') {
    const id = Number(item.id ?? item.chatId);
    if (Number.isFinite(id)) {
      await apiPost('/api/chats/switch', { id });
      store.activeView = null;
      renderAll();
    }
    return;
  }
  if (kind === 'project') {
    const dir = item.dir ?? item.path ?? item.id;
    if (dir) {
      const res = await apiPost('/api/project/open', { dir });
      store.root = res.root;
      store.project = res.project;
      store.projects = res.projects ?? store.projects;
      store.previewFile = null;
      store.activeView = null;
      await refreshMetadata();
      showToast(`Proje açıldı: ${res.project}`);
    }
    return;
  }
  if (kind === 'agent') {
    store.activeView = 'agents';
    store.expandedAgentsCard = item.agent ?? item.id ?? null;
    renderAll();
    refreshMetadata();
    return;
  }
  if (kind === 'setting') {
    store.activeView = 'settings';
    store.settingsTab = item.tab || 'general';
    renderAll();
    refreshMetadata();
  }
}

function wireEvents() {
  const form = document.getElementById('composer-form');
  const input = document.getElementById('prompt-input');

  form?.addEventListener('submit', (e) => {
    e.preventDefault();
    submitPrompt();
  });

  input?.addEventListener('input', () => autoResizePrompt(input));
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitPrompt();
    }
  });

  wireCustomSelects(async (name, value) => {
    if (name === 'taskSubMode') {
      store.taskSubMode = value || 'code_review';
      renderComposerState();
      return;
    }
    if (name === 'uiTheme' || name === 'ui-theme') {
      applyTheme(value);
      persistUiPrefs();
      renderViewOverlay(handleCanvasSend);
      return;
    }
    if (name === 'ui-font' || name === 'uiFont') {
      store.font = value || 'inter';
      persistUiPrefs();
      renderViewOverlay(handleCanvasSend);
      return;
    }
    if (name === 'uiLang' || name === 'project-lang') {
      try {
        const res = await apiPost('/api/lang', { lang: value });
        if (store.state) store.state.lang = res.lang;
        showToast(`Dil güncellendi: ${res.lang}`);
      } catch (e) {
        showToast(e.message);
      }
      return;
    }
    if (name === 'apiProvider' || name === 'api-provider') {
      store.selectedApiProvider = value;
      return;
    }
    if (name === 'handoffTarget' || name === 'hof-to') {
      store.handoffTarget = value;
    }
  });

  document.getElementById('btn-sidebar-toggle')?.addEventListener('click', () => {
    store.sidebarExpanded = !store.sidebarExpanded;
    saveLayoutToggles();
    renderSidebar();
  });

  document.querySelector('.sidebar-brand')?.addEventListener('click', () => {
    if (!store.sidebarExpanded) {
      store.sidebarExpanded = true;
      saveLayoutToggles();
      renderSidebar();
    } else {
      store.activeView = null;
      store.plusPopoverOpen = false;
      store.modelPopoverOpen = false;
      renderAll();
    }
  });

  document.getElementById('btn-right-toggle')?.addEventListener('click', () => {
    store.rightPanelOpen = !store.rightPanelOpen;
    saveLayoutToggles();
    renderTopbar();
    renderRightPanel();
    if (store.rightPanelOpen) refreshFast();
  });

  document.getElementById('btn-theme')?.addEventListener('click', () => {
    applyTheme(store.theme === 'dark' ? 'light' : 'dark');
    if (store.activeView === 'customization') renderViewOverlay(handleCanvasSend);
  });

  document.getElementById('btn-new-chat')?.addEventListener('click', async () => {
    try {
      await apiPost('/api/chats/new', {});
      store.activeView = null;
      store.plusPopoverOpen = false;
      store.modelPopoverOpen = false;
      showToast('Yeni sohbet açıldı');
    } catch (e) {
      showToast(e.message);
    }
  });

  document.getElementById('btn-new-project')?.addEventListener('click', () => {
    store.sidebarExpanded = true;
    store.projectFormOpen = !store.projectFormOpen;
    saveLayoutToggles();
    renderSidebar();
    if (store.projectFormOpen) {
      document.getElementById('proj-dir-input')?.focus();
    }
  });

  document.getElementById('btn-handoff-quick')?.addEventListener('click', () => {
    store.rightPanelOpen = true;
    store.rightTab = 'memory';
    saveLayoutToggles();
    renderTopbar();
    renderRightPanel();
    refreshMetadata();
  });

  document.getElementById('btn-composer-plus')?.addEventListener('click', (e) => {
    e.stopPropagation();
    store.plusPopoverOpen = !store.plusPopoverOpen;
    if (store.plusPopoverOpen) store.modelPopoverOpen = false;
    renderPopovers();
  });

  document.getElementById('btn-model-trigger')?.addEventListener('click', (e) => {
    e.stopPropagation();
    store.modelPopoverOpen = !store.modelPopoverOpen;
    if (store.modelPopoverOpen) store.plusPopoverOpen = false;
    renderPopovers();
  });

  document.getElementById('btn-write-toggle')?.addEventListener('click', () => {
    store.allowWrite = !store.allowWrite;
    renderComposerState();
  });

  document.getElementById('btn-mcp-target')?.addEventListener('click', cycleMcpTarget);

  document.getElementById('btn-view-close')?.addEventListener('click', () => {
    store.activeView = null;
    renderAll();
  });

  document.getElementById('view-overlay')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) {
      store.activeView = null;
      renderAll();
    }
  });

  document.getElementById('file-upload-input')?.addEventListener('change', async (e) => {
    const file = e.target?.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const res = await apiPost('/api/upload', { dataUrl });
      store.pendingImage = res.url;
      renderComposerState();
      showToast('Görsel yüklendi');
    } catch (err) {
      showToast(err?.message || 'Görsel yüklenemedi');
    }
  });

  document.getElementById('bundle-upload-input')?.addEventListener('change', async (e) => {
    const files = Array.from(e.target?.files || []);
    e.target.value = '';
    if (!files.length) return;
    try {
      const payload = await Promise.all(
        files.slice(0, 50).map(async (f) => ({
          path: f.webkitRelativePath || f.name,
          name: f.name,
          dataBase64: await readFileAsBase64(f),
        })),
      );
      const res = await apiPost('/api/upload/bundle', { files: payload });
      store.pendingBundle = res;
      renderComposerState();
      showToast(`${res.count} dosya yüklendi`);
    } catch (err) {
      showToast(err?.message || 'Dosya paketi yüklenemedi');
    }
  });

  // Model-aware silky effort slider + search & filter live inputs
  document.addEventListener('input', (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;

    if (t.matches('[data-effort-slider]')) {
      const ag = t.dataset.effortSlider;
      const efforts = (t.dataset.efforts || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const list = efforts.length ? efforts : EFFORT_STOPS;
      const maxIdx = Math.max(0, list.length - 1);
      const idx = Math.min(maxIdx, Math.max(0, Math.round(Number(t.value) || 0)));
      const stop = list[idx] || list[0] || 'medium';
      const pct = list.length > 1 ? (idx / (list.length - 1)) * 100 : 0;

      const box = t.closest('.effort-slider-box');
      const fill = box?.querySelector('.effort-track-fill');
      const thumb = box?.querySelector('.effort-thumb');
      if (fill) fill.style.width = `${pct}%`;
      if (thumb) thumb.style.left = `${pct}%`;

      const lblEl =
        document.querySelector(`[data-effort-label="${CSS.escape(ag)}"]`) ||
        document.querySelector(`[data-effort-val="${CSS.escape(ag)}"]`);
      if (lblEl) lblEl.textContent = EFFORT_LABELS[stop] || stop;
      document.querySelectorAll(`[data-effort-stop="${CSS.escape(ag)}"]`).forEach((btn) => {
        btn.classList.toggle('active', Number(btn.dataset.stopIdx) === idx);
      });
      return;
    }

    if (t.id === 'search-input') {
      const val = t.value;
      const pos = t.selectionStart ?? val.length;
      store.searchQuery = val;
      store.searchIdx = 0;
      renderSearchOverlay();
      const nextInput = document.getElementById('search-input');
      if (nextInput && document.activeElement !== nextInput) {
        nextInput.value = val;
        nextInput.focus();
        nextInput.setSelectionRange?.(pos, pos);
      }
      return;
    }

    if (t.id === 'settings-search-input') {
      const val = t.value;
      const pos = t.selectionStart ?? val.length;
      store.settingsQuery = val;
      renderViewOverlay(handleCanvasSend);
      const nextInput = document.getElementById('settings-search-input');
      if (nextInput) {
        nextInput.value = val;
        nextInput.focus();
        nextInput.setSelectionRange?.(pos, pos);
      }
      return;
    }

    if (t.id === 'files-filter-input') {
      const val = t.value;
      const pos = t.selectionStart ?? val.length;
      renderRightPanel();
      const nextInput = document.getElementById('files-filter-input');
      if (nextInput) {
        nextInput.value = val;
        nextInput.focus();
        nextInput.setSelectionRange?.(pos, pos);
      }
    }
  });

  document.addEventListener('change', async (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;

    if (t.id === 'toggle-concise' && t instanceof HTMLInputElement) {
      store.conciseMode = Boolean(t.checked);
      try {
        localStorage.setItem('masiva-concise', store.conciseMode ? '1' : '0');
      } catch {
        /* ignore */
      }
      renderMessages();
      renderViewOverlay(handleCanvasSend);
      return;
    }

    if (t.id === 'toggle-task-anim' && t instanceof HTMLInputElement) {
      store.taskAnim = Boolean(t.checked);
      persistUiPrefs();
      renderTopbar();
      return;
    }

    if (t.id === 'toggle-right-default' && t instanceof HTMLInputElement) {
      store.rightPanelOpen = Boolean(t.checked);
      saveLayoutToggles();
      renderTopbar();
      renderRightPanel();
      return;
    }

    if (!t.matches('[data-effort-slider]')) return;
    const ag = t.dataset.effortSlider;
    const efforts = (t.dataset.efforts || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const list = efforts.length ? efforts : EFFORT_STOPS;
    const maxIdx = Math.max(0, list.length - 1);
    const idx = Math.min(maxIdx, Math.max(0, Math.round(Number(t.value) || 0)));
    const effort = list[idx] || list[0] || 'medium';
    try {
      await updateAgentEffort(ag, effort);
    } catch (err) {
      showToast(err?.message || 'Effort kaydedilemedi');
    }
  });

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === ',') {
      e.preventDefault();
      store.activeView = 'settings';
      store.searchOpen = false;
      store.plusPopoverOpen = false;
      store.modelPopoverOpen = false;
      renderAll();
      refreshMetadata();
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      if (store.searchOpen) {
        store.searchOpen = false;
        renderSearchOverlay();
      } else {
        store.searchOpen = true;
        store.searchQuery = '';
        store.searchIdx = 0;
        const si = document.getElementById('search-input');
        if (si) si.value = '';
        renderSearchOverlay();
        setTimeout(() => document.getElementById('search-input')?.focus(), 20);
      }
      return;
    }

    if (store.searchOpen) {
      if (e.key === 'Escape') {
        e.preventDefault();
        store.searchOpen = false;
        renderSearchOverlay();
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const items = buildSearchItems(store.searchQuery || '');
        if (items.length) {
          e.preventDefault();
          const dir = e.key === 'ArrowDown' ? 1 : -1;
          store.searchIdx = ((store.searchIdx || 0) + dir + items.length) % items.length;
          renderSearchOverlay();
        }
        return;
      }
      if (e.key === 'Enter') {
        const items = buildSearchItems(store.searchQuery || '');
        const picked = items[store.searchIdx || 0];
        if (picked) {
          e.preventDefault();
          executeSearchItem(picked).catch((err) => showToast(err?.message || 'İşlem başarısız'));
        }
        return;
      }
    }

    if (e.key === 'Escape') {
      let changed = false;
      if (store.plusPopoverOpen) {
        store.plusPopoverOpen = false;
        changed = true;
      }
      if (store.modelPopoverOpen) {
        store.modelPopoverOpen = false;
        changed = true;
      }
      if (store.activeView) {
        store.activeView = null;
        changed = true;
      }
      if (changed) renderAll();
    }
  });

  document.addEventListener('click', async (e) => {
    try {
      const t = e.target instanceof Element ? e.target : null;
      if (!t) return;

      if (store.modelPopoverOpen && !t.closest('#model-popover') && !t.closest('#btn-model-trigger')) {
        store.modelPopoverOpen = false;
        renderPopovers();
      }
      if (store.plusPopoverOpen && !t.closest('#plus-popover') && !t.closest('#btn-composer-plus')) {
        store.plusPopoverOpen = false;
        renderPopovers();
      }

      const topModeBtn = t.closest('#top-mode-switch .mode-switch-btn');
      if (topModeBtn) {
        if (isActiveChatLocked()) {
          showToast('Bu sohbet Direct/Task modunda kilitli. Mod değiştirmek için Yeni Sohbet aç.');
          return;
        }
        const nextMode = topModeBtn.dataset.topMode === 'task' ? 'task' : 'direct';
        store.topMode = nextMode;
        syncSelectedAgents();
        renderTopbar();
        renderComposerState();
        renderPopovers();
        return;
      }

      if (t.id === 'search-overlay') {
        store.searchOpen = false;
        renderSearchOverlay();
        return;
      }

      const clearBtn = t.closest('[data-clear-input]');
      if (clearBtn) {
        const targetId = clearBtn.dataset.clearInput;
        const targetEl = targetId ? document.getElementById(targetId) : null;
        if (targetEl) targetEl.value = '';
        if (targetId === 'settings-search-input') {
          store.settingsQuery = '';
          renderViewOverlay(handleCanvasSend);
          document.getElementById('settings-search-input')?.focus();
        } else if (targetId === 'files-filter-input') {
          renderRightPanel();
          document.getElementById('files-filter-input')?.focus();
        } else if (targetId === 'search-input') {
          store.searchQuery = '';
          store.searchIdx = 0;
          renderSearchOverlay();
          document.getElementById('search-input')?.focus();
        }
        return;
      }

      const searchItem = t.closest('.search-item[data-search-idx], [data-search-idx]');
      if (searchItem) {
        const idx = Number(searchItem.dataset.searchIdx);
        const items = buildSearchItems(store.searchQuery || '');
        if (Number.isFinite(idx) && items[idx]) {
          await executeSearchItem(items[idx]);
        }
        return;
      }

      if (t.closest('#btn-profile-open')) {
        store.activeView = 'settings';
        store.settingsTab = 'account';
        store.plusPopoverOpen = false;
        store.modelPopoverOpen = false;
        renderAll();
        refreshFast();
        return;
      }

      if (t.closest('#btn-settings-quick')) {
        store.activeView = 'settings';
        store.plusPopoverOpen = false;
        store.modelPopoverOpen = false;
        renderAll();
        refreshFast();
        return;
      }

      const settingsTabBtn = t.closest('[data-settings-tab]');
      if (settingsTabBtn) {
        store.settingsTab = settingsTabBtn.dataset.settingsTab || 'general';
        renderViewOverlay(handleCanvasSend);
        return;
      }

      const conciseBtn = t.closest('#toggle-concise');
      if (conciseBtn && !(conciseBtn instanceof HTMLInputElement)) {
        store.conciseMode = !store.conciseMode;
        try {
          localStorage.setItem('masiva-concise', store.conciseMode ? '1' : '0');
        } catch {
          /* ignore */
        }
        renderMessages();
        renderViewOverlay(handleCanvasSend);
        return;
      }

      const agentCfgBtn = t.closest('[data-agent-cfg]');
      if (agentCfgBtn) {
        const ag = agentCfgBtn.dataset.agentCfg;
        store.expandedAgentsCard = store.expandedAgentsCard === ag ? null : ag;
        renderViewOverlay(handleCanvasSend);
        return;
      }

      const expandMsgBtn = t.closest('[data-expand-msg]');
      if (expandMsgBtn) {
        const id = String(expandMsgBtn.dataset.expandMsg || '');
        if (id) {
          if (expandedMessages.has(id)) expandedMessages.delete(id);
          else expandedMessages.add(id);
          renderMessages();
        }
        return;
      }

      const viewBtn = t.closest('[data-view]');
      if (viewBtn) {
        const nextView = viewBtn.dataset.view;
        if (nextView === 'customization') {
          store.activeView = 'settings';
          store.settingsTab = 'appearance';
        } else {
          store.activeView = store.activeView === nextView ? null : nextView;
        }
        store.plusPopoverOpen = false;
        store.modelPopoverOpen = false;
        renderAll();
        if (store.activeView === 'agents') {
          refreshMetadata();
        } else if (store.activeView && store.activeView !== 'canvas') {
          refreshFast();
        }
        return;
      }

      const rpTab = t.closest('[data-rp-tab]');
      if (rpTab) {
        store.rightTab = rpTab.dataset.rpTab || 'memory';
        store.rightPanelOpen = true;
        saveLayoutToggles();
        renderTopbar();
        renderRightPanel();
        if (store.rightTab === 'files' || store.rightTab === 'memory' || store.rightTab === 'locks') {
          refreshFast();
        }
        return;
      }

      const plusItem = t.closest('[data-plus]');
      if (plusItem) {
        const action = plusItem.dataset.plus;
        store.plusPopoverOpen = false;
        renderPopovers();
        if (action === 'image') {
          document.getElementById('file-upload-input')?.click();
        } else if (action === 'bundle') {
          document.getElementById('bundle-upload-input')?.click();
        } else if (action === 'canvas') {
          store.activeView = 'canvas';
          renderAll();
        } else if (action === 'handoff') {
          store.rightPanelOpen = true;
          store.rightTab = 'memory';
          saveLayoutToggles();
          renderTopbar();
          renderRightPanel();
          refreshMetadata();
        }
        return;
      }

      if (t.closest('[data-clear-image]')) {
        store.pendingImage = null;
        renderComposerState();
        return;
      }
      if (t.closest('[data-clear-bundle]')) {
        store.pendingBundle = null;
        renderComposerState();
        return;
      }

      const copyBtn = t.closest('[data-copy-encoded]');
      if (copyBtn) {
        await copyText(decodeURIComponent(copyBtn.dataset.copyEncoded || ''));
        return;
      }

      const quickBtn = t.closest('.quick-chip');
      if (quickBtn) {
        if (quickBtn.dataset.openRp) {
          store.rightPanelOpen = true;
          store.rightTab = quickBtn.dataset.openRp;
          saveLayoutToggles();
          renderTopbar();
          renderRightPanel();
          refreshMetadata();
          return;
        }
        if (quickBtn.dataset.topMode && !isActiveChatLocked()) {
          store.topMode = quickBtn.dataset.topMode === 'task' ? 'task' : 'direct';
          if (quickBtn.dataset.submode) store.taskSubMode = quickBtn.dataset.submode;
          syncSelectedAgents();
          renderTopbar();
          renderComposerState();
          renderPopovers();
        }
        if (quickBtn.dataset.prompt && input) {
          input.value = quickBtn.dataset.prompt;
          autoResizePrompt(input);
          input.focus();
        }
        return;
      }

      const toggleAg = t.closest('[data-toggle-agent]');
      if (toggleAg) {
        const ag = toggleAg.dataset.toggleAgent;
        if (store.topMode === 'direct') {
          store.selectedAgents = [ag];
          store.modelPopoverOpen = false;
        } else {
          const exists = store.selectedAgents.includes(ag);
          if (exists && store.selectedAgents.length > 1) {
            store.selectedAgents = store.selectedAgents.filter((x) => x !== ag);
          } else if (!exists) {
            store.selectedAgents = [...store.selectedAgents.slice(-2), ag];
          }
        }
        renderComposerState();
        renderPopovers();
        return;
      }

      const expandAg = t.closest('[data-expand-agent]');
      if (expandAg) {
        const ag = expandAg.dataset.expandAgent;
        store.expandedModelAgent = store.expandedModelAgent === ag ? null : ag;
        renderPopovers();
        return;
      }

      const pickModel = t.closest('[data-pick-model]');
      if (pickModel) {
        await apiPost('/api/agents/prefs', {
          agent: pickModel.dataset.pickModel,
          selectedModel: pickModel.dataset.val,
        });
        await refreshMetadata();
        showToast(`Model seçildi: ${pickModel.dataset.val}`);
        return;
      }

      const effortStop = t.closest('[data-effort-stop]');
      if (effortStop) {
        const ag = effortStop.dataset.effortStop;
        const val = effortStop.dataset.val;
        if (ag && val) {
          await updateAgentEffort(ag, val);
        }
        return;
      }

      const cmdBtn = t.closest('[data-cmd-id]');
      if (cmdBtn) {
        await apiPost('/api/command/resolve', {
          id: Number(cmdBtn.dataset.cmdId),
          decision: cmdBtn.dataset.cmdDec,
        });
        return;
      }

      const mcpTab = t.closest('[data-mcp-tab]');
      if (mcpTab) {
        store.mcpClientTab = mcpTab.dataset.mcpTab;
        renderViewOverlay(handleCanvasSend);
        return;
      }

      const openAg = t.closest('[data-open-agent]');
      if (openAg) {
        const res = await apiPost('/api/agent/open', { agent: openAg.dataset.openAgent });
        showToast(res.ok ? `${openAg.dataset.openAgent} açıldı` : res.error || 'Ajan açılamadı');
        return;
      }

      const saveBehavior = t.closest('[data-save-agent-behavior]');
      if (saveBehavior) {
        const ag = saveBehavior.dataset.saveAgentBehavior;
        const field = document.querySelector(`[data-agent-behavior="${CSS.escape(ag)}"]`);
        await apiPost('/api/agents/prefs', { agent: ag, behavior: field?.value ?? '' });
        await refreshMetadata();
        showToast('Ajan davranışı kaydedildi');
        return;
      }

      const setTheme = t.closest('[data-set-theme]');
      if (setTheme) {
        applyTheme(setTheme.dataset.setTheme);
        renderViewOverlay(handleCanvasSend);
        return;
      }

      const setAccent = t.closest('[data-set-accent]');
      if (setAccent) {
        store.accent = setAccent.dataset.setAccent || 'sapphire';
        persistUiPrefs();
        renderViewOverlay(handleCanvasSend);
        return;
      }

      const swChat = t.closest('[data-switch-chat]');
      if (swChat) {
        await apiPost('/api/chats/switch', { id: Number(swChat.dataset.switchChat) });
        return;
      }

      const delChat = t.closest('[data-del-chat]');
      if (delChat) {
        await apiPost('/api/chats/delete', { id: Number(delChat.dataset.delChat) });
        return;
      }

      const openProj = t.closest('[data-open-proj]');
      if (openProj) {
        const dir = openProj.dataset.openProj;
        const res = await apiPost('/api/project/open', { dir });
        store.root = res.root;
        store.project = res.project;
        store.projects = res.projects ?? store.projects;
        store.previewFile = null;
        await refreshMetadata();
        showToast(`Proje açıldı: ${res.project}`);
        return;
      }

      const archiveProj = t.closest('[data-archive-proj]');
      if (archiveProj) {
        const dir = archiveProj.dataset.archiveProj;
        const res = await apiPost('/api/project/archive', { dir, archived: true });
        store.projects = res.projects ?? store.projects;
        if (res.switched && res.currentProject) {
          store.root = res.root;
          store.project = res.currentProject.name;
        }
        await refreshMetadata();
        showToast('Proje arşivlendi');
        return;
      }

      if (t.id === 'btn-open-project') {
        const dir = document.getElementById('proj-dir-input')?.value?.trim();
        if (!dir) return showToast('Proje klasör yolu girin');
        const res = await apiPost('/api/project/open', { dir });
        store.root = res.root;
        store.project = res.project;
        store.projects = res.projects ?? store.projects;
        store.projectFormOpen = false;
        store.previewFile = null;
        await refreshMetadata();
        showToast(`Proje açıldı: ${res.project}`);
        return;
      }

      if (t.id === 'btn-create-project') {
        const dir = document.getElementById('proj-dir-input')?.value?.trim();
        if (!dir) return showToast('Yeni proje yolu veya adı girin');
        const baseName = dir.split(/[\\/]/).filter(Boolean).pop() || 'yeni-proje';
        const isPath = /[\\/]/.test(dir);
        const res = await apiPost('/api/project/create', isPath ? { name: baseName, dir } : { name: baseName });
        store.root = res.root;
        store.project = res.project?.name || baseName;
        store.projects = res.projects ?? store.projects;
        store.projectFormOpen = false;
        store.previewFile = null;
        await refreshMetadata();
        showToast(`Proje oluşturuldu: ${store.project}`);
        return;
      }

      if (t.id === 'btn-save-memory') {
        const goal = document.getElementById('mem-goal-input')?.value ?? '';
        const text = document.getElementById('mem-decision-input')?.value?.trim() ?? '';
        store.memory = await apiPost('/api/memory/decision', { goal, agent: 'human', text });
        const decInput = document.getElementById('mem-decision-input');
        if (decInput) decInput.value = '';
        renderRightPanel();
        showToast('Proje hafızası güncellendi');
        return;
      }

      if (t.id === 'btn-send-handoff') {
        const to =
          document.getElementById('hof-to-select')?.dataset?.value ||
          store.handoffTarget ||
          'antigravity';
        const goal = document.getElementById('hof-goal-input')?.value?.trim() || '';
        const filesRaw = document.getElementById('hof-files-input')?.value || '';
        if (!goal) return showToast('Handoff görevi boş olamaz');
        const files = filesRaw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        const res = await apiPost('/api/memory/handoff', { from: 'human', to, goal, files });
        showToast(res.notice || `Handoff gönderildi → ${to}`);
        await refreshMetadata();
        return;
      }

      const unlockBtn = t.closest('[data-unlock-file]');
      if (unlockBtn) {
        await apiPost('/api/unlock', { file: unlockBtn.dataset.unlockFile });
        showToast(`Kilit açıldı: ${unlockBtn.dataset.unlockFile}`);
        return;
      }

      if (t.id === 'btn-refresh-tree') {
        const res = await apiGet('/api/tree');
        store.treeFiles = res.files ?? [];
        renderRightPanel();
        return;
      }

      const previewBtn = t.closest('[data-preview-file]');
      if (previewBtn) {
        const filePath = previewBtn.dataset.previewFile;
        const res = await apiGet(`/api/file?path=${encodeURIComponent(filePath)}`);
        store.previewFile = res;
        renderRightPanel();
        return;
      }

      if (t.id === 'btn-close-file-preview') {
        store.previewFile = null;
        renderRightPanel();
        return;
      }

      if (t.id === 'btn-save-apikey') {
        const provider =
          document.getElementById('api-provider-select')?.dataset?.value ||
          store.selectedApiProvider ||
          'openai';
        const apiKey = document.getElementById('api-key-input')?.value ?? '';
        const res = await apiPost('/api/settings/api-keys', { provider, apiKey });
        store.apiKeys = res.keys ?? store.apiKeys;
        showToast('API anahtarı güncellendi');
        await refreshMetadata();
        return;
      }

      if (t.id === 'btn-pull-ollama') {
        const model = t.dataset.model || 'qwen2.5-coder:3b';
        showToast(`${model} indiriliyor...`);
        const res = await apiPost('/api/ollama/pull', { model });
        showToast(res.ok ? `${model} hazır!` : res.error || 'İndirme başarısız');
        await refreshMetadata();
        return;
      }

      if (t.id === 'btn-create-skill') {
        const name = document.getElementById('skill-name-input')?.value?.trim() || '';
        const description = document.getElementById('skill-desc-input')?.value?.trim() || '';
        const agent = document.getElementById('skill-agent-select')?.dataset?.value || '';
        const instructions = document.getElementById('skill-instructions-input')?.value?.trim() || '';
        const res = await apiPost('/api/skills/create', {
          name,
          description,
          instructions: instructions || undefined,
          agent: agent || null,
        });
        store.skills = res.skills ?? store.skills;
        showToast(`Yetenek oluşturuldu: ${name}`);
        renderViewOverlay(handleCanvasSend);
        return;
      }

      if (t.id === 'btn-save-lang') {
        const lang = document.getElementById('lang-select')?.dataset?.value || 'tr';
        const res = await apiPost('/api/lang', { lang });
        if (store.state) store.state.lang = res.lang;
        showToast(`Proje dili kaydedildi: ${res.lang}`);
        return;
      }

      if (t.id === 'btn-save-perplexity') {
        const apiKey = document.getElementById('perplexity-key-input')?.value ?? '';
        await apiPost('/api/settings/perplexity', { apiKey });
        showToast('Perplexity anahtarı güncellendi');
        await refreshMetadata();
        return;
      }

      if (t.id === 'btn-git-remote') {
        const url = document.getElementById('git-remote-input')?.value?.trim() || '';
        store.gitStatus = await apiPost('/api/git/remote', { url });
        renderViewOverlay(handleCanvasSend);
        showToast('Git remote ayarlandı');
        return;
      }

      if (t.id === 'btn-git-commit' || t.id === 'btn-git-push') {
        const push = t.id === 'btn-git-push';
        const message = document.getElementById('git-commit-msg')?.value?.trim() || '';
        const res = await apiPost('/api/git/commit', { message, push });
        store.gitStatus = await apiGet('/api/git/status').catch(() => store.gitStatus);
        renderViewOverlay(handleCanvasSend);
        showToast(res.pushed ? `Commit & Push tamamlandı (${res.hash})` : `Commit tamamlandı (${res.hash})`);
        return;
      }

      if (t.id === 'btn-git-auth') {
        const token = document.getElementById('git-token-input')?.value?.trim() || undefined;
        const userName = document.getElementById('git-user-input')?.value?.trim() || undefined;
        store.gitStatus = await apiPost('/api/git/auth', { token, userName });
        renderViewOverlay(handleCanvasSend);
        showToast('GitHub bağlantısı güncellendi');
        return;
      }

      if (t.id === 'btn-git-logout') {
        store.gitStatus = await apiPost('/api/git/logout', {});
        renderViewOverlay(handleCanvasSend);
        showToast('GitHub çıkışı yapıldı');
      }
    } catch (err) {
      showToast(err?.message || 'İşlem başarısız');
    }
  });
}

function init() {
  restoreLocalPreferences();
  setCanvasSendHandler(handleCanvasSend);
  wireEvents();
  renderAll();
  refreshMetadata();

  connectSse({
    onInit: (d) => {
      store.state = d.state;
      if (store.state && d.lang) store.state.lang = d.lang;
      store.events = d.events ?? [];
      store.diffs = d.diffs ?? [];
      store.liveSessions = d.liveSessions ?? [];
      store.liveTurns = d.liveTurns ?? d.turns ?? [];
      store.project = d.project || store.project;
      store.root = d.root || store.root;
      store.projects = d.projects ?? [];
      ensureActiveChatLockFromEvents();
      renderAll();
    },
    onEvents: (list) => {
      const ids = new Set(store.events.map((x) => x.id));
      for (const ev of list ?? []) {
        if (!ids.has(ev.id)) store.events.push(ev);
      }
      ensureActiveChatLockFromEvents();
      renderAll();
    },
    onState: (d) => {
      store.state = d.state;
      if (store.state && d.lang) store.state.lang = d.lang;
      ensureActiveChatLockFromEvents();
      renderAll();
    },
    onDiffs: (list) => {
      const ids = new Set(store.diffs.map((x) => x.id));
      for (const df of list ?? []) {
        if (!ids.has(df.id)) store.diffs.push(df);
      }
      renderRightPanel();
    },
    onLive: (d) => {
      store.liveSessions = d.sessions ?? d.liveSessions ?? [];
      store.liveTurns = d.liveTurns ?? d.turns ?? [];
      renderAll();
    },
  });

  setInterval(async () => {
    try {
      const usage = await apiGet('/api/usage');
      if (usage) {
        store.usage = usage;
        if (usage.profileStats) store.profileStats = usage.profileStats;
        if (store.rightPanelOpen) renderRightPanel();
        if (store.activeView === 'settings' || store.activeView === 'profile') {
          renderViewOverlay(handleCanvasSend);
        }
      }
    } catch {
      /* ignore periodic usage refresh failures */
    }
  }, 15_000);
}

init();
