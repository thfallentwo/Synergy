export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatInline(raw) {
  let out = escapeHtml(raw);
  out = out.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  return out;
}

function renderProseBlock(block) {
  const lines = block.split(/\r?\n/);
  const parts = [];
  let inList = false;

  for (const line of lines) {
    const bullet = /^\s*[-*]\s+(.+)$/.exec(line);
    if (bullet) {
      if (!inList) {
        parts.push('<ul>');
        inList = true;
      }
      parts.push(`<li>${formatInline(bullet[1])}</li>`);
      continue;
    }
    if (inList) {
      parts.push('</ul>');
      inList = false;
    }
    if (line.trim()) {
      parts.push(`<p>${formatInline(line)}</p>`);
    }
  }
  if (inList) parts.push('</ul>');
  return parts.join('');
}

export function renderMarkdown(text) {
  const src = String(text ?? '');
  const fence = /```([a-zA-Z0-9_-]*)\r?\n([\s\S]*?)```/g;
  const out = [];
  let cursor = 0;
  let m;

  while ((m = fence.exec(src)) !== null) {
    if (m.index > cursor) {
      out.push(renderProseBlock(src.slice(cursor, m.index)));
    }
    const lang = escapeHtml(m[1] || 'code');
    const code = m[2];
    const encoded = encodeURIComponent(code);
    out.push(
      `<div class="code-block"><div class="code-head"><span>${lang}</span><button type="button" class="sub-chip" data-copy-encoded="${encoded}">Kopyala</button></div><pre><code>${escapeHtml(code)}</code></pre></div>`,
    );
    cursor = m.index + m[0].length;
  }

  if (cursor < src.length) {
    out.push(renderProseBlock(src.slice(cursor)));
  }

  return out.join('') || `<p>${escapeHtml(src)}</p>`;
}
