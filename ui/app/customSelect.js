import { escapeHtml } from './markdown.js';

let wired = false;
let selectHandler = null;

function normalizeOptions(options = []) {
  return options.map((opt) =>
    typeof opt === 'string'
      ? { value: opt, label: opt }
      : {
          value: String(opt?.value ?? ''),
          label: String(opt?.label ?? opt?.value ?? ''),
          meta: opt?.meta ? String(opt.meta) : '',
        },
  );
}

export function closeAllCustomSelects(except = null) {
  document.querySelectorAll('.cselect.is-open').forEach((el) => {
    if (except && el === except) return;
    el.classList.remove('is-open');
    const trig = el.querySelector('.cselect-trigger');
    if (trig) trig.setAttribute('aria-expanded', 'false');
  });
}

export function renderCustomSelect({
  id = '',
  name = '',
  value = '',
  options = [],
  placeholder = 'Seç...',
  up = false,
  compact = false,
} = {}) {
  const list = normalizeOptions(options);
  const valStr = String(value ?? '');
  const selected = list.find((o) => o.value === valStr) || null;
  const label = selected ? selected.label : placeholder;
  const classes = ['cselect'];
  if (up) classes.push('cselect-up');
  if (compact) classes.push('cselect-compact');

  const idAttr = id ? ` id="${escapeHtml(id)}"` : '';
  const nameVal = name || id || '';

  const itemsHtml = list
    .map((opt) => {
      const isActive = opt.value === valStr;
      return `
        <button
          type="button"
          class="cselect-option${isActive ? ' is-selected active' : ''}"
          role="option"
          aria-selected="${isActive ? 'true' : 'false'}"
          data-value="${escapeHtml(opt.value)}"
        >
          <span class="cselect-opt-label">${escapeHtml(opt.label)}</span>
          ${opt.meta ? `<span class="cselect-opt-meta">${escapeHtml(opt.meta)}</span>` : ''}
        </button>
      `;
    })
    .join('');

  return `
    <div${idAttr} class="${classes.join(' ')}" data-cselect="${escapeHtml(nameVal)}" data-value="${escapeHtml(selected ? selected.value : valStr)}">
      <button type="button" class="cselect-trigger" aria-haspopup="listbox" aria-expanded="false">
        <span class="cselect-label">${escapeHtml(label)}</span>
        <svg class="cselect-caret" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
          <path d="m4 6 4 4 4-4" />
        </svg>
      </button>
      <div class="cselect-menu" role="listbox">
        ${itemsHtml || `<div class="cselect-empty">${escapeHtml(placeholder)}</div>`}
      </div>
    </div>
  `;
}

export function wireCustomSelects(onSelect) {
  selectHandler = typeof onSelect === 'function' ? onSelect : null;
  if (wired) return;
  wired = true;

  document.addEventListener('click', (e) => {
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;

    const optBtn = target.closest('.cselect-option');
    if (optBtn) {
      const root = optBtn.closest('.cselect');
      if (!root) return;
      const val = optBtn.dataset.value ?? '';
      const labelEl = optBtn.querySelector('.cselect-opt-label');
      const trigLabel = root.querySelector('.cselect-label');
      if (trigLabel && labelEl) trigLabel.textContent = labelEl.textContent || val;

      root.dataset.value = val;
      root.querySelectorAll('.cselect-option').forEach((o) => {
        const match = o === optBtn;
        o.classList.toggle('is-selected', match);
        o.classList.toggle('active', match);
        o.setAttribute('aria-selected', match ? 'true' : 'false');
      });

      closeAllCustomSelects();
      const name = root.dataset.cselect || root.id || '';
      selectHandler?.(name, val, root);
      return;
    }

    const trig = target.closest('.cselect-trigger');
    if (trig) {
      e.stopPropagation();
      const root = trig.closest('.cselect');
      if (!root) return;
      const willOpen = !root.classList.contains('is-open');
      closeAllCustomSelects(root);
      root.classList.toggle('is-open', willOpen);
      trig.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
      return;
    }

    if (!target.closest('.cselect')) {
      closeAllCustomSelects();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeAllCustomSelects();
    }
  });
}
