import { execFileSync, spawn } from 'node:child_process';
import os from 'node:os';
import { isOllamaRunning } from './apiRunner';

export interface OllamaRecommendation {
  installed: boolean;
  running: boolean;
  totalRamGb: number;
  recommendedModel: string;
  installedModels: string[];
  installUrl: string;
  pullCommand: string;
}

export interface OllamaPullResult {
  ok: boolean;
  model: string;
  output?: string;
  error?: string;
  installUrl: string;
}

const OLLAMA_INSTALL_URL = 'https://ollama.com/download';

function isOllamaCliInstalled(): boolean {
  try {
    const checker = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(checker, ['ollama'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return out.length > 0;
  } catch {
    return false;
  }
}

/** Inspect host RAM and local Ollama status; suggest an appropriate Qwen 2.5 Coder tag without modifying the OS. */
export async function getOllamaRecommendation(fetchImpl: typeof fetch = fetch): Promise<OllamaRecommendation> {
  const totalRamGb = Math.round((os.totalmem() / 1024 ** 3) * 10) / 10;
  const recommendedModel = totalRamGb < 12 ? 'qwen2.5-coder:3b' : 'qwen2.5-coder:7b';
  const status = await isOllamaRunning(fetchImpl);
  const installed = isOllamaCliInstalled() || status.running;
  return {
    installed,
    running: status.running,
    totalRamGb,
    recommendedModel,
    installedModels: status.models,
    installUrl: OLLAMA_INSTALL_URL,
    pullCommand: `ollama pull ${recommendedModel}`,
  };
}

/** Pull a local Ollama model if the `ollama` binary is present on PATH. */
export function pullOllamaModel(modelRaw: string, timeoutMs = 600_000): Promise<OllamaPullResult> {
  const model = String(modelRaw ?? '').trim();
  if (!model || !/^[a-zA-Z0-9._:/-]+$/.test(model)) {
    return Promise.resolve({
      ok: false,
      model,
      error: 'Geçersiz model adı.',
      installUrl: OLLAMA_INSTALL_URL,
    });
  }
  if (!isOllamaCliInstalled()) {
    return Promise.resolve({
      ok: false,
      model,
      error: 'Ollama kurulu değil. Önce ollama.com üzerinden kurup yeniden deneyin.',
      installUrl: OLLAMA_INSTALL_URL,
    });
  }

  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let settled = false;
    const child = spawn('ollama', ['pull', model], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      resolve({ ok: false, model, error: 'Model indirme zaman aşımına uğradı.', installUrl: OLLAMA_INSTALL_URL });
    }, timeoutMs);

    child.stdout?.on('data', (d: Buffer) => {
      if (out.length < 8000) out += d.toString('utf8');
    });
    child.stderr?.on('data', (d: Buffer) => {
      if (err.length < 4000) err += d.toString('utf8');
    });
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, model, error: e.message, installUrl: OLLAMA_INSTALL_URL });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ ok: true, model, output: out.trim() || `Pulled ${model}`, installUrl: OLLAMA_INSTALL_URL });
      } else {
        resolve({
          ok: false,
          model,
          error: (err || out).trim().slice(-300) || `ollama pull çıkış kodu: ${code}`,
          installUrl: OLLAMA_INSTALL_URL,
        });
      }
    });
  });
}
