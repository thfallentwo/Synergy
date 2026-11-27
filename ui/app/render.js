import { renderCustomSelect } from './customSelect.js';
import { escapeHtml, renderMarkdown } from './markdown.js';
import { diffBadge, getSessionRollups, lucideIcon, renderRightPanel, renderViewOverlay } from './panels.js';
import { renderSearchOverlay } from './search.js';
import {
  EFFORT_LABELS,
  EFFORT_STOPS,
  MODE_LABELS,
  TASK_SUBMODES,
  agentDisplay,
  agentIconPath,
  getChatMode,
  mcpIdeAgents,
  runnableAgents,
  store,
} from './state.js';

let toastTimer = null;
let canvasSendHandler = null;
export const expandedMessages = new Set();

function syncTopModeDataset() {
  const mode = store.topMode === 'task' ? 'task' : 'direct';
  document.documentElement.dataset.topMode = mode;
  const stage = document.getElementById('stage');
  if (stage) stage.dataset.topMode = mode;
}

function statusTagIcon(tag) {
  const upper = String(tag || '').toUpperCase();
  if (upper.includes('MODIFIED')) return lucideIcon('editing');
  if (upper.includes('READING')) return lucideIcon('reading');
  if (upper.includes('WORKING')) return lucideIcon('working');
  if (upper.includes('TESTING')) return lucideIcon('running');
  if (upper.includes('DONE')) return lucideIcon('check');
  if (upper.includes('HANDOFF')) return lucideIcon('thinking');
  return '';
}

export function setCanvasSendHandler(fn) {
  canvasSendHandler = typeof fn === 'function' ? fn : null;
}

export function showToast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = String(msg ?? '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 2600);
}

function fmtTime(ts) {
  try {
    return new Date(ts).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function sameDir(a, b) {
  if (!a || !b) return false;
  return String(a).replace(/[\\/]+$/, '').toLowerCase() === String(b).replace(/[\\/]+$/, '').toLowerCase();
}

export function isActiveChatLocked() {
  const activeChatId = store.state?.activeChatId;
  if (activeChatId != null && getChatMode(activeChatId)) return true;
  return (store.events ?? []).some((e) => e.type === 'human' || e.type === 'ask');
}

export function renderSidebar() {
  const sidebar = document.getElementById('sidebar');
  if (sidebar) {
    sidebar.classList.toggle('is-expanded', Boolean(store.sidebarExpanded));
  }
  const toggleBtn = document.getElementById('btn-sidebar-toggle');
  if (toggleBtn) {
    toggleBtn.setAttribute('aria-expanded', store.sidebarExpanded ? 'true' : 'false');
  }

  document.querySelectorAll('[data-view]').forEach((btn) => {
    const view = btn.dataset.view;
    btn.classList.toggle('active', Boolean(store.activeView) && store.activeView === view);
  });

  const projList = document.getElementById('sidebar-projects');
  if (projList) {
    const projs = (store.projects ?? []).filter((p) => !p.archived);
    const formHtml = store.projectFormOpen
      ? `
        <div class="card" style="padding:8px;gap:6px;margin-bottom:6px">
          <input id="proj-dir-input" class="field" style="padding:6px 8px;font-size:12px" placeholder="Proje klasör yolu..." value="${escapeHtml(store.root || '')}" />
          <div style="display:flex;gap:5px">
            <button type="button" class="btn btn-primary" id="btn-open-project" style="flex:1;padding:5px 8px;font-size:11.5px">Aç</button>
            <button type="button" class="btn" id="btn-create-project" style="flex:1;padding:5px 8px;font-size:11.5px">Oluştur</button>
          </div>
        </div>
      `
      : '';

    const itemsHtml = projs.length
      ? projs
          .map((p) => {
            const active = sameDir(p.dir, store.root);
            return `
              <div class="sidebar-item-row ${active ? 'active' : ''}">
                <button type="button" class="sidebar-item-title" data-open-proj="${escapeHtml(p.dir)}" title="${escapeHtml(p.dir)}" style="text-align:left">
                  ${p.emoji ? `${escapeHtml(p.emoji)} ` : ''}${escapeHtml(p.name)}
                </button>
                <button type="button" class="sidebar-item-del" data-archive-proj="${escapeHtml(p.dir)}" title="Arşivle">×</button>
              </div>
            `;
          })
          .join('')
      : '<div style="padding:4px 10px;font-size:11.5px;color:var(--text-dim)">Kayıtlı proje yok</div>';

    projList.innerHTML = formHtml + itemsHtml;
  }

  const chatList = document.getElementById('sidebar-chats');
  if (chatList) {
    const chats = (store.state?.chats ?? []).filter((c) => !c.archived);
    const activeId = store.state?.activeChatId;
    chatList.innerHTML = chats.length
      ? chats
          .map((c) => {
            const isActive = c.id === activeId;
            const lockedMode = getChatMode(c.id) || (isActive && isActiveChatLocked() ? store.topMode : null);
            const modeLabel = lockedMode === 'task' ? 'Task' : lockedMode === 'direct' ? 'Direct' : '';
            return `
              <div class="sidebar-item-row ${isActive ? 'active' : ''}">
                <button type="button" class="sidebar-item-title" data-switch-chat="${c.id}" style="text-align:left;display:flex;align-items:center;justify-content:space-between;gap:6px">
                  <span style="overflow:hidden;text-overflow:ellipsis">${escapeHtml(c.title)}</span>
                  ${modeLabel ? `<span class="msg-tag" style="font-size:9.5px;padding:0 5px;flex-shrink:0">${modeLabel}</span>` : ''}
                </button>
                ${
                  chats.length > 1
                    ? `<button type="button" class="sidebar-item-del" data-del-chat="${c.id}" title="Sohbeti Sil">×</button>`
                    : ''
                }
              </div>
            `;
          })
          .join('')
      : '<div style="padding:4px 10px;font-size:11.5px;color:var(--text-dim)">Sohbet yok</div>';
  }
}

export function renderTopbar() {
  syncTopModeDataset();
  const projName = document.getElementById('project-name');
  if (projName) projName.textContent = store.project || 'Masiva Labs';

  const locks = store.state?.locks ?? [];
  const badge = document.getElementById('locks-badge');
  if (badge) {
    badge.hidden = locks.length === 0;
    badge.textContent = String(locks.length);
  }

  const presence = document.getElementById('mcp-presence');
  if (presence) {
    const roomAgents = new Map((store.state?.agents ?? []).map((a) => [a.name, a]));
    const liveIds = new Set((store.liveSessions ?? []).map((s) => s.agent));
    const chips = mcpIdeAgents()
      .map((a) => {
        const room = roomAgents.get(a.agent);
        const online = room?.status === 'working' || room?.status === 'idle' || liveIds.has(a.agent);
        if (!online && a.agent !== 'antigravity' && a.agent !== 'cursor') return '';
        const dotCls = online ? 'dot-live' : 'dot-idle';
        const statusLabel = online ? 'Bağlı' : 'MCP';
        return `<button type="button" class="pill-chip" data-view="agents" title="${escapeHtml(a.reason || '')}">
          <img class="chip-logo" src="${agentIconPath(a.agent)}" alt="" />
          <span>${escapeHtml(a.display)}</span>
          <span style="opacity:.65">· ${statusLabel}</span>
          ${diffBadge(room?.added, room?.removed)}
        </button>`;
      })
      .filter(Boolean);
    presence.innerHTML = chips.join('');
  }

  const modeSwitch = document.getElementById('top-mode-switch');
  if (modeSwitch) {
    const activeMode = store.topMode === 'task' ? 'task' : 'direct';
    const locked = isActiveChatLocked();
    modeSwitch.dataset.active = activeMode;
    modeSwitch.classList.toggle('is-locked', locked);
    modeSwitch.querySelectorAll('.mode-switch-btn').forEach((btn) => {
      const btnMode = btn.dataset.topMode;
      const isAct = btnMode === activeMode;
      btn.classList.toggle('active', isAct);
      btn.setAttribute('aria-selected', isAct ? 'true' : 'false');
    });
  }

  const rightToggle = document.getElementById('btn-right-toggle');
  if (rightToggle) {
    rightToggle.classList.toggle('active', Boolean(store.rightPanelOpen));
    rightToggle.setAttribute('aria-expanded', store.rightPanelOpen ? 'true' : 'false');
  }
}

export function renderMessages() {
  const stage = document.getElementById('stage');
  const container = document.getElementById('messages');
  if (!stage || !container) return;

  const events = store.events ?? [];
  const pending = store.state?.pendingCommands ?? [];
  const bound = getSessionRollups().connected;
  const isEmptyChat = events.length === 0 && pending.length === 0 && bound.length === 0;
  stage.dataset.empty = isEmptyChat ? 'true' : 'false';
  if (isEmptyChat) {
    container.innerHTML = '';
    return;
  }

  const html = [];
  for (const ev of events) {
    if (ev.type === 'human') {
      const targetTag = ev.to_agent
        ? `<div class="msg-tag" style="margin-bottom:4px;display:inline-block">@${escapeHtml(ev.to_agent)}</div>`
        : '';
      const imgHtml = ev.image
        ? `<div style="margin-bottom:8px"><img src="${escapeHtml(ev.image)}" alt="Ekli görsel" style="max-width:260px;max-height:200px;border-radius:12px;display:block;border:1px solid var(--border)" /></div>`
        : '';
      html.push(`<div class="msg-human">${targetTag}${imgHtml}${ev.text ? renderMarkdown(ev.text) : ''}</div>`);
      continue;
    }

    if (ev.type === 'system' || ev.type === 'lock' || ev.type === 'unlock') {
      const label =
        ev.type === 'lock'
          ? `${agentDisplay(ev.agent)} kilitledi: ${ev.file}`
          : ev.type === 'unlock'
            ? `${agentDisplay(ev.agent)} kilidi açtı: ${ev.file}`
            : ev.text;
      html.push(`<div class="msg-system">${escapeHtml(label)}</div>`);
      continue;
    }

    let bodyText = ev.text || '';
    let tag = ev.type === 'status' ? `${ev.action || 'STATUS'}${ev.file && ev.file !== '-' ? ` · ${ev.file}` : ''}` : '';
    const bracket = /^\[([^\]]+)\]\s*([\s\S]*)$/.exec(bodyText);
    if (bracket) {
      tag = bracket[1];
      bodyText = bracket[2];
    }
    const targetNote =
      ev.to_agent && ev.to_agent !== 'human' ? `<span class="msg-tag">→ ${escapeHtml(ev.to_agent)}</span>` : '';
    const imgHtml = ev.image
      ? `<div style="margin-bottom:8px"><img src="${escapeHtml(ev.image)}" alt="Görsel" style="max-width:280px;max-height:220px;border-radius:12px;display:block;border:1px solid var(--border)" /></div>`
      : '';

    const tagIcon = tag ? statusTagIcon(tag) : '';
    const msgId = String(ev.id ?? '');
    const lineCount = bodyText.split(/\r?\n/).length;
    const isLong = lineCount > 4 || bodyText.length > 340;
    const isExpanded = msgId ? expandedMessages.has(msgId) : false;
    const shouldClamp = Boolean(store.conciseMode) && isLong && !isExpanded;
    const msgTextHtml = `<div class="msg-text">${renderMarkdown(bodyText)}</div>`;
    const bodyBlock = shouldClamp
      ? `<div class="msg-body-clamped">${msgTextHtml}</div>`
      : msgTextHtml;
    const expandBtn =
      Boolean(store.conciseMode) && isLong && msgId
        ? `<button type="button" class="msg-expand-btn" data-expand-msg="${escapeHtml(msgId)}">${isExpanded ? 'Daralt' : 'Tamamını gör'}</button>`
        : '';

    html.push(`
      <article class="msg-agent">
        <img class="msg-avatar" src="${agentIconPath(ev.agent)}" alt="${escapeHtml(ev.agent)}" />
        <div class="msg-body">
          <div class="msg-head">
            <span class="msg-author">${escapeHtml(agentDisplay(ev.agent))}</span>
            ${tag ? `<span class="msg-tag">${tagIcon}${escapeHtml(tag)}</span>` : ''}
            ${targetNote}
            <span class="msg-time">${fmtTime(ev.ts)}</span>
          </div>
          ${imgHtml}
          ${bodyBlock}
          ${expandBtn}
        </div>
      </article>
    `);
  }

  for (const r of bound) {
    const state = r.working ? 'Working' : 'Tamamlandı';
    const sum = r.finalText || r.lastLabel || (r.working ? 'İşlem sürüyor…' : 'Hazır');
    html.push(`
      <article class="msg-agent msg-live-session">
        <img class="msg-avatar" src="${agentIconPath(r.agent)}" alt="${escapeHtml(r.agent)}" />
        <div class="msg-body">
          <div class="msg-head">
            <span class="msg-author">${escapeHtml(r.title || agentDisplay(r.agent))}</span>
            <span class="msg-tag">${lucideIcon(r.working ? 'working' : 'check')} ${state}</span>
            ${diffBadge(r.added, r.removed)}
          </div>
          <div class="msg-text">${renderMarkdown(String(sum).slice(0, 600))}</div>
        </div>
      </article>
    `);
  }

  for (const cmd of pending) {
    html.push(`
      <div class="cmd-approval-card">
        <div>
          <div style="font-size:12px;color:var(--warn);font-weight:600">Komut Onayı Bekleniyor (#${cmd.id})</div>
          <div style="font-size:13px">${escapeHtml(cmd.from_agent)} → ${escapeHtml(cmd.to_agent)}: <code>${escapeHtml(cmd.command)}</code></div>
        </div>
        <div style="display:flex;gap:6px">
          <button type="button" class="btn btn-primary" data-cmd-id="${cmd.id}" data-cmd-dec="allow">İzin Ver</button>
          <button type="button" class="btn" data-cmd-id="${cmd.id}" data-cmd-dec="always">Hep</button>
          <button type="button" class="btn" data-cmd-id="${cmd.id}" data-cmd-dec="deny">Reddet</button>
        </div>
      </div>
    `);
  }

  const nearBottom = container.parentElement
    ? container.parentElement.scrollHeight - container.parentElement.scrollTop - container.parentElement.clientHeight < 120
    : true;
  container.innerHTML = html.join('');
  if (nearBottom && container.parentElement) {
    container.parentElement.scrollTop = container.parentElement.scrollHeight;
  }
}

function renderComposerAttachments() {
  const form = document.getElementById('composer-form');
  if (!form) return;
  let strip = document.getElementById('composer-attachments');
  const hasImg = Boolean(store.pendingImage);
  const hasBundle = Boolean(store.pendingBundle);

  if (!hasImg && !hasBundle) {
    strip?.remove();
    return;
  }

  if (!strip) {
    strip = document.createElement('div');
    strip.id = 'composer-attachments';
    strip.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px;';
    form.insertBefore(strip, form.firstChild);
  }

  const parts = [];
  if (hasImg) {
    parts.push(`
      <div class="pill-chip" style="height:auto;padding:4px 8px 4px 4px;gap:6px">
        <img src="${escapeHtml(store.pendingImage)}" alt="Görsel" style="width:24px;height:24px;border-radius:6px;object-fit:cover" />
        <span>Görsel eklendi</span>
        <button type="button" data-clear-image="1" title="Kaldır" style="font-weight:700;opacity:.75">×</button>
      </div>
    `);
  }
  if (hasBundle) {
    parts.push(`
      <div class="pill-chip">
        <span>📁 ${escapeHtml(store.pendingBundle.count)} dosya (${escapeHtml(store.pendingBundle.bundleDir)})</span>
        <button type="button" data-clear-bundle="1" title="Kaldır" style="font-weight:700;opacity:.75">×</button>
      </div>
    `);
  }
  strip.innerHTML = parts.join('');
}

export function renderComposerState() {
  renderComposerAttachments();

  const subSlot = document.getElementById('task-submode-slot');
  const writeBtn = document.getElementById('btn-write-toggle');
  const mcpBtn = document.getElementById('btn-mcp-target');

  if (store.topMode === 'task') {
    if (subSlot) {
      subSlot.hidden = false;
      subSlot.innerHTML = renderCustomSelect({
        id: 'task-submode-select',
        name: 'taskSubMode',
        value: store.taskSubMode || 'code_review',
        options: TASK_SUBMODES,
        placeholder: 'Görev Modu',
        up: true,
        compact: true,
      });
    }
    if (writeBtn) {
      writeBtn.hidden = store.taskSubMode !== 'code_review' && store.taskSubMode !== 'relay';
      writeBtn.classList.toggle('active', Boolean(store.allowWrite));
      writeBtn.textContent = store.allowWrite ? 'Dosya Yazma: Açık' : 'Dosya Yazma: Kapalı';
    }
    if (mcpBtn) {
      mcpBtn.hidden = store.taskSubMode !== 'code_review';
      mcpBtn.classList.toggle('active', Boolean(store.mcpTarget));
      mcpBtn.textContent = store.mcpTarget ? `→ ${agentDisplay(store.mcpTarget)}` : '→ IDE MCP';
    }
  } else {
    if (subSlot) {
      subSlot.innerHTML = '';
    }
    if (writeBtn) writeBtn.hidden = true;
    if (mcpBtn) mcpBtn.hidden = true;
  }

  const trigContent = document.getElementById('model-trigger-content');
  if (trigContent) {
    const selected = store.selectedAgents
      .map((id) => store.catalog.find((c) => c.agent === id))
      .filter(Boolean);
    if (!selected.length) {
      trigContent.innerHTML = `<span>Ajan Seç</span>`;
    } else if (selected.length === 1) {
      const a = selected[0];
      const sub = a.selectedModel || a.defaultModel || '';
      const supportedEfforts = (a.effortsByModel && sub && a.effortsByModel[sub]) || a.efforts || [];
      const effRaw = supportedEfforts.length ? a.reasoningEffort || '' : '';
      const eff = effRaw && supportedEfforts.includes(effRaw) ? EFFORT_LABELS[effRaw] || effRaw : '';
      const meta = [sub, eff].filter(Boolean).join(' · ');
      const detail = meta ? `${agentDisplay(a.agent)} (${meta})` : agentDisplay(a.agent);
      trigContent.innerHTML = `<span class="trigger-avatars"><img src="${agentIconPath(a.agent)}" alt=""/></span><span>${escapeHtml(detail)}</span>`;
    } else {
      const imgs = selected.map((a) => `<img src="${agentIconPath(a.agent)}" alt=""/>`).join('');
      trigContent.innerHTML = `<span class="trigger-avatars">${imgs}</span><span>${selected.length} Ajan Seçili</span>`;
    }
  }

  const modeLabel = document.getElementById('meta-mode-label');
  if (modeLabel) {
    if (store.topMode === 'task') {
      const subObj = TASK_SUBMODES.find((s) => s.value === store.taskSubMode);
      const subLabel = subObj?.label || MODE_LABELS[store.taskSubMode] || store.taskSubMode;
      modeLabel.textContent = `Task · ${subLabel}`;
    } else {
      modeLabel.textContent = 'Direct';
    }
  }

  const statusText = document.getElementById('meta-status-text');
  const sendBtn = document.getElementById('btn-send');
  if (sendBtn) sendBtn.disabled = Boolean(store.busy);
  if (statusText) {
    if (store.busy) {
      statusText.textContent = 'Ajanlar çalışıyor...';
    } else if (store.topMode === 'task') {
      if (store.taskSubMode === 'debate') {
        statusText.textContent = 'En az 2 çalıştırılabilir ajan önerilir (2 tur + sentez)';
      } else if (store.taskSubMode === 'code_review') {
        statusText.textContent = '1. ajan kodlar, 2. ajan diff üzerinden denetler';
      } else {
        statusText.textContent = 'Seçili ajanlar çıktıyı sırayla devralır';
      }
    } else {
      statusText.textContent = runnableAgents().length
        ? 'Yalnızca aktif mesajlaşılabilir ajanlar listelenir'
        : 'Başlamak için Agents menüsünden bir CLI veya API bağla';
    }
  }
}

export function renderPopovers() {
  const plusPop = document.getElementById('plus-popover');
  const plusBtn = document.getElementById('btn-composer-plus');
  if (plusPop) {
    plusPop.classList.toggle('is-open', Boolean(store.plusPopoverOpen));
    plusPop.setAttribute('aria-hidden', store.plusPopoverOpen ? 'false' : 'true');
    if (!plusPop.dataset.built) {
      plusPop.dataset.built = '1';
      plusPop.innerHTML = `
        <div class="plus-section">
          <div class="plus-section-title">Ekle & Araçlar</div>
          <button type="button" class="plus-row" data-plus="image">
            <span>Görsel Yükle</span>
            <span class="agent-badge">Resim</span>
          </button>
          <button type="button" class="plus-row" data-plus="bundle">
            <span>Klasör / Dosya Yükle</span>
            <span class="agent-badge">Çoklu</span>
          </button>
          <button type="button" class="plus-row" data-plus="canvas">
            <span>Canvas Aç</span>
            <span class="agent-badge">Çizim</span>
          </button>
          <button type="button" class="plus-row" data-plus="handoff">
            <span>Limit Devri</span>
            <span class="agent-badge">Handoff</span>
          </button>
        </div>
      `;
    }
  }
  if (plusBtn) {
    plusBtn.classList.toggle('is-open', Boolean(store.plusPopoverOpen));
    plusBtn.setAttribute('aria-expanded', store.plusPopoverOpen ? 'true' : 'false');
  }

  const pop = document.getElementById('model-popover');
  const trigger = document.getElementById('btn-model-trigger');
  if (!pop || !trigger) return;

  trigger.setAttribute('aria-expanded', store.modelPopoverOpen ? 'true' : 'false');
  pop.classList.toggle('is-open', Boolean(store.modelPopoverOpen));
  pop.setAttribute('aria-hidden', store.modelPopoverOpen ? 'false' : 'true');

  if (!store.modelPopoverOpen) return;

  const runnable = runnableAgents();
  if (!runnable.length) {
    pop.innerHTML = `
      <div class="card" style="margin:2px">
        <div style="font-weight:600;font-size:13px">Aktif Runnable Ajan Yok</div>
        <div style="font-size:12px;color:var(--text-muted)">Antigravity ve Cursor IDE MCP dinleyicisidir. Doğrudan yanıt için Codex/Gemini/Claude CLI oturumu açın, API anahtarı ekleyin veya Ollama başlatın.</div>
        <button type="button" class="btn btn-primary" data-view="agents">Ajan Bağla & MCP Kur</button>
      </div>
    `;
    return;
  }

  const multiHint = store.topMode === 'direct' ? 'Tek ajan seçilir' : 'Çoklu seçim (2-3 ajan)';
  const rows = runnable
    .map((a) => {
      const selected = store.selectedAgents.includes(a.agent);
      const curModel = a.selectedModel || a.defaultModel || '';
      const efforts = (a.effortsByModel && curModel && a.effortsByModel[curModel]) || a.efforts || [];
      const expanded = store.expandedModelAgent === a.agent;

      const modelChips = (a.models ?? [])
        .map(
          (m) =>
            `<button type="button" class="sub-chip ${curModel === m ? 'active' : ''}" data-pick-model="${escapeHtml(a.agent)}" data-val="${escapeHtml(m)}">${escapeHtml(m)}</button>`,
        )
        .join('');

      let subText = curModel || 'Varsayılan ayar';
      let effortHtml = '<div class="effort-unsupported" style="font-size:11.5px;color:var(--text-dim);padding:4px 0">Bu model effort ayarı desteklemiyor</div>';

      if (efforts.length > 0) {
        const curEffort = a.reasoningEffort || '';
        const rawIdx = efforts.indexOf(curEffort);
        const fallbackIdx = efforts.includes('medium') ? efforts.indexOf('medium') : 0;
        const idx = rawIdx >= 0 ? rawIdx : fallbackIdx;
        const activeStop = efforts[idx] || efforts[0];
        const label = EFFORT_LABELS[activeStop] || activeStop;
        const pct = efforts.length > 1 ? (idx / (efforts.length - 1)) * 100 : 0;
        subText = [curModel, label].filter(Boolean).join(' · ') || 'Varsayılan ayar';

        const ticksHtml = efforts
          .map((stop, sIdx) => {
            const tickLabel = stop === 'medium' ? 'Med' : EFFORT_LABELS[stop] || stop;
            return `
              <button type="button" class="effort-tick ${sIdx === idx ? 'active' : ''}" data-effort-stop="${escapeHtml(a.agent)}" data-stop-idx="${sIdx}" data-val="${escapeHtml(stop)}">
                <span class="effort-dot"></span>
                <span>${escapeHtml(tickLabel)}</span>
              </button>
            `;
          })
          .join('');

        effortHtml = `
          <div class="effort-wrap">
            <div class="effort-header"><span>Effort</span><strong data-effort-label="${escapeHtml(a.agent)}">${escapeHtml(label)}</strong></div>
            <div class="effort-slider-box">
              <div class="effort-track"><div class="effort-track-fill" style="width:${pct}%"></div></div>
              <div class="effort-thumb" style="left:${pct}%"></div>
              <input type="range" class="effort-slider" min="0" max="${efforts.length - 1}" step="1" value="${idx}" data-effort-slider="${escapeHtml(a.agent)}" data-efforts="${escapeHtml(efforts.join(','))}" />
            </div>
            <div class="effort-ticks">${ticksHtml}</div>
          </div>
        `;
      }

      const subDrawer = `
        <div class="agent-subdrawer ${expanded ? 'is-open' : ''}">
          <div class="agent-subdrawer-inner">
            ${modelChips ? `<div style="font-size:11px;color:var(--text-muted)">Model</div><div class="chip-grid">${modelChips}</div>` : ''}
            ${effortHtml}
          </div>
        </div>
      `;

      return `
        <div class="agent-row ${selected ? 'selected' : ''}">
          <div class="agent-row-main">
            <button type="button" class="agent-row-left" data-toggle-agent="${escapeHtml(a.agent)}">
              <img class="agent-icon" src="${agentIconPath(a.agent)}" alt="" />
              <div style="min-width:0">
                <div class="agent-title">${escapeHtml(agentDisplay(a.agent))}</div>
                <div class="agent-sub">${escapeHtml(subText)}</div>
              </div>
            </button>
            <span class="agent-badge">${escapeHtml(a.transport)}</span>
            <button type="button" class="agent-expand-btn" data-expand-agent="${escapeHtml(a.agent)}" title="Model ve Effort Seç">${expanded ? '▴' : '▾'}</button>
          </div>
          ${subDrawer}
        </div>
      `;
    })
    .join('');

  pop.innerHTML = `
    <div class="popover-head">
      <span>Çalıştırılabilir Ajanlar</span>
      <span>${multiHint}</span>
    </div>
    ${rows}
    <div class="row-between" style="padding:8px 4px 2px;border-top:1px solid var(--border);margin-top:6px">
      <span style="font-size:11.5px;color:var(--text-muted)">IDE MCP Oturumları: ${mcpIdeAgents().length}</span>
      <button type="button" class="sub-chip" data-view="agents">Bağlantılar & Ollama</button>
    </div>
  `;
}

export function renderAll() {
  syncTopModeDataset();
  renderSidebar();
  renderTopbar();
  renderMessages();
  renderComposerState();
  renderPopovers();
  renderRightPanel();
  renderViewOverlay(canvasSendHandler);
  renderSearchOverlay();
}
