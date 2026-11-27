import fs from 'node:fs';
import path from 'node:path';

const PROTECTED_REGEX =
  /```[\s\S]*?```|`[^`]+`|https?:\/\/\S+|(?:^|\s)(?:@[a-zA-Z0-9_-]+|\/[a-zA-Z0-9_-]+)|\b(?:[\w.-]+\/)*[\w.-]+\.(?:ts|tsx|js|jsx|py|lua|luau|json|md|html|css|sql|yml|yaml)\b|\b(?:API|MCP|SDK|SQL|SQLite|CSS|HTML|DOM|JSON|SSE|HTTP|HTTPS|URL|URI|UUID|React|Node|TypeScript|JavaScript|GitHub|DeepSeek|Gemini|Claude|Antigravity|Codex|Nemotron|Perplexity|Copilot|Grok|Kimi|Canvas|Agora|UI|UX|CLI|IDE)\b/g;

function extractProtected(text: string): { masked: string; tokens: string[] } {
  const tokens: string[] = [];
  const masked = text.replace(PROTECTED_REGEX, (match) => {
    const lead = match.startsWith(' ') ? ' ' : '';
    const core = lead ? match.slice(1) : match;
    const idx = tokens.length;
    tokens.push(core);
    return `${lead}__AGORA_T${idx}__`;
  });
  return { masked, tokens };
}

function restoreProtected(text: string, tokens: string[]): string {
  return text.replace(/__AGORA_T(\d+)__/g, (_m, i) => tokens[Number(i)] ?? '');
}

function readStoredApiKey(root: string, provider: string): string {
  try {
    const file = path.join(root, '.synergy', 'api-keys.json');
    if (!fs.existsSync(file)) return '';
    const obj = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>;
    return (obj[provider] ?? '').trim();
  } catch {
    return '';
  }
}

/**
 * Translate prompt prose into `targetLang` while keeping technical terms, `@mentions`,
 * `/commands`, inline code, and filenames intact.
 */
export async function translatePrompt(
  rawText: string,
  rawTargetLang: string,
  root: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ translated: string; provider: string }> {
  const text = rawText.trim();
  const targetLang = (rawTargetLang || 'en').trim().toLowerCase() || 'en';
  if (!text) return { translated: '', provider: 'none' };

  const { masked, tokens } = extractProtected(text);

  // If no translatable words remain besides placeholders, return immediately.
  if (!masked.replace(/__AGORA_T\d+__/g, '').trim()) {
    return { translated: text, provider: 'noop' };
  }

  // Prefer high-limit Gemini/DeepSeek API key if user configured one locally, else Google free GTX endpoint.
  const deepseekKey = readStoredApiKey(root, 'deepseek');
  if (deepseekKey) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 6000);
      const res = await fetchImpl('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${deepseekKey}` },
        body: JSON.stringify({
          model: 'deepseek-chat',
          temperature: 0.1,
          messages: [
            {
              role: 'system',
              content: `Translate the user's text to language "${targetLang}". Keep every __AGORA_T<n>__ placeholder exact and unchanged. Output ONLY the translated text.`,
            },
            { role: 'user', content: masked },
          ],
        }),
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (res.ok) {
        const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
        const out = j.choices?.[0]?.message?.content?.trim();
        if (out) return { translated: restoreProtected(out, tokens), provider: 'deepseek' };
      }
    } catch {
      /* fallback below */
    }
  }

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(targetLang)}&dt=t&q=${encodeURIComponent(masked)}`;
    const res = await fetchImpl(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (res.ok) {
      const arr = (await res.json()) as unknown[];
      if (Array.isArray(arr) && Array.isArray(arr[0])) {
        const joined = (arr[0] as Array<[string]>).map((seg) => seg[0] ?? '').join('').trim();
        if (joined) return { translated: restoreProtected(joined, tokens), provider: 'translator' };
      }
    }
  } catch {
    /* offline fallback */
  }

  return { translated: text, provider: 'fallback' };
}
