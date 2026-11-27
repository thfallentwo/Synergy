function tokenHeader() {
  const token = document.querySelector('meta[name="synergy-token"]')?.getAttribute('content') || '';
  return { 'X-Synergy-Token': token };
}

export async function apiGet(path) {
  const res = await fetch(path, { cache: 'no-store' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export async function apiPost(path, body = {}) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...tokenHeader() },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export function connectSse(handlers) {
  let es = null;
  let closed = false;

  const parse = (ev, fn) => {
    try {
      fn?.(JSON.parse(ev.data));
    } catch {
      /* ignore malformed SSE frame */
    }
  };

  const open = () => {
    if (closed) return;
    es = new EventSource('/events');
    es.addEventListener('init', (ev) => parse(ev, handlers.onInit));
    es.addEventListener('events', (ev) => parse(ev, handlers.onEvents));
    es.addEventListener('state', (ev) => parse(ev, handlers.onState));
    es.addEventListener('diffs', (ev) => parse(ev, handlers.onDiffs));
    es.addEventListener('live', (ev) => parse(ev, handlers.onLive));
    es.onerror = () => {
      es?.close();
      if (!closed) setTimeout(open, 2000);
    };
  };

  open();
  return () => {
    closed = true;
    es?.close();
  };
}
