import fs from 'node:fs';
import path from 'node:path';

export function perplexityKeyPath(root: string): string {
  return path.join(root, '.synergy', 'secrets.json');
}

function maskKey(key: string): string {
  if (key.length <= 8) return '••••';
  return `${key.slice(0, 5)}••••${key.slice(-3)}`;
}

export function readPerplexityKey(root?: string): string | null {
  const envKey = process.env.PERPLEXITY_API_KEY?.trim();
  if (envKey) return envKey;
  if (!root) return null;
  try {
    const raw = fs.readFileSync(perplexityKeyPath(root), 'utf8');
    const parsed = JSON.parse(raw) as { perplexityApiKey?: string };
    const k = parsed.perplexityApiKey?.trim();
    return k || null;
  } catch {
    return null;
  }
}

export function perplexityKeyStatus(root: string): { configured: boolean; masked: string } {
  const k = readPerplexityKey(root);
  return k ? { configured: true, masked: maskKey(k) } : { configured: false, masked: '' };
}

export function savePerplexityKey(root: string, apiKey: string): { configured: boolean; masked: string } {
  const clean = apiKey.trim();
  const file = perplexityKeyPath(root);
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    data = {};
  }
  if (!clean) {
    delete data.perplexityApiKey;
  } else {
    data.perplexityApiKey = clean;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  return perplexityKeyStatus(root);
}

export async function queryPerplexityApi(
  query: string,
  apiKey?: string,
  root?: string,
): Promise<string | null> {
  const resolved = apiKey?.trim() || readPerplexityKey(root);
  if (!resolved) return null;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15_000);
  try {
    const res = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${resolved}`,
      },
      body: JSON.stringify({
        model: 'sonar',
        messages: [
          { role: 'system', content: 'Return a concise, factual report in max 35 words.' },
          { role: 'user', content: query },
        ],
      }),
      signal: ac.signal,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Perplexity API HTTP ${res.status}${txt ? `: ${txt.slice(0, 120)}` : ''}`);
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = json.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error('Perplexity returned an empty response');
    return content;
  } finally {
    clearTimeout(timer);
  }
}
