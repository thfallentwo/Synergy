import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  getAgentCatalog,
  getCliStatusList,
  hasAgentApiKey,
  hasAgentCli,
  hasReadyAgentCli,
  runAgentUnified,
  setupAgentCli,
} from '../core/apiRunner';
import { MCP_IDE_AGENTS, normalizeAgent } from '../core/agents';
import {
  appendMemoryDecision,
  buildHandoffBrief,
  buildSharedContextPrompt,
  getGitDiffSummary,
  readProjectMemory,
  recordHandoff,
  renderContextMarkdown,
  setProjectGoal,
} from '../core/memory';
import { getOllamaRecommendation, pullOllamaModel } from '../core/ollamaBootstrap';
import { runOrchestration, type OrchestrationMode } from '../core/orchestrator';
import {
  accumulateAgentStats,
  apiKeyStatusList,
  createSkill,
  discoverSkills,
  readAgentPrefs,
  readProfileStats,
  recordAgentFeedback,
  recordFiveHourTokens,
  saveProviderApiKey,
  updateAgentPref,
} from '../core/customization';
import { clearGitHubAuth, commitAndPush, getGitStatus, saveGitHubAuth, setGitRemote } from '../core/git';
import { openAgentTarget } from '../core/launcher';
import { LiveObserver } from '../core/liveObserver';
import { dbPath, normalizeFile } from '../core/paths';
import { perplexityKeyStatus, queryPerplexityApi, readPerplexityKey, savePerplexityKey } from '../core/perplexity';
import { Synergy } from '../core/service';
import { openDb } from '../core/store';
import { listProjectFiles } from '../core/tree';
import type { AgentView, CommandRow, ProjectMeta, StateSnapshot, UsageItem } from '../core/types';
import { collectUsageWindow } from '../core/usage';
import {
  addWorkflowAttachment,
  mutateWorkflowTask,
  readWorkflow,
  saveWorkflowPatch,
  stepWorkflowAutopilot,
} from '../core/workflow';
import {
  addProjectSources,
  defaultProjectsFilePath,
  listFolders,
  readProjectSources,
  readProjects,
  removeProjectSource,
  samePath,
  upsertProjectMeta,
  writeProjectsFile,
} from './projectRegistry';
import { tryServeStaticAsset } from './staticAssets';

export interface UiServer {
  url: string;
  port: number;
  token: string;
  close(): Promise<void>;
}

export interface UiOptions {
  port?: number;
  /** Directory holding index.html, styles/, app/, and icons/. */
  uiDir: string;
  pollMs?: number;
  observe?: boolean;
  projectsFile?: string;
}

const HOST = '127.0.0.1';
const MAX_BODY = 10_000;
const MAX_UPLOAD_BODY = 20_000_000;
const LARGE_BODY_ROUTES = new Set([
  '/api/upload',
  '/api/upload/bundle',
  '/api/workflow/upload',
  '/api/project/sources/upload',
  '/api/skills/create',
  '/api/project/create',
  '/api/file/save',
  '/api/orchestrate',
]);

interface Client {
  res: http.ServerResponse;
  lastId: number;
  lastDiffId: number;
  chatRev: number;
  projectRev: number;
  liveRev: number;
  sig: string;
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage, maxBytes = MAX_BODY): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error('body too large'));
        req.destroy();
      } else {
        chunks.push(c);
      }
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function handleUploadImage(root: string, dataUrl: string): string {
  const m = /^data:image\/(png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/=]+)$/i.exec(dataUrl);
  if (!m) throw new Error('invalid image data');
  const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 5_000_000) throw new Error('image too large (max 5MB)');
  const dir = path.join(root, '.synergy', 'uploads');
  fs.mkdirSync(dir, { recursive: true });
  const name = `${crypto.randomUUID()}.${ext}`;
  fs.writeFileSync(path.join(dir, name), buf);
  return `/uploads/${name}`;
}

function handleUploadBundle(root: string, rawFiles: unknown[]) {
  const id = crypto.randomUUID().slice(0, 8);
  const bundleRel = path.posix.join('.synergy', 'uploads', 'bundles', id);
  const bundleAbs = path.join(root, bundleRel);
  fs.mkdirSync(bundleAbs, { recursive: true });
  const names: string[] = [];
  for (const f of rawFiles.slice(0, 50)) {
    if (!f || typeof f !== 'object') continue;
    const rawRel = String((f as Record<string, unknown>).path ?? (f as Record<string, unknown>).name ?? '').replace(/\\/g, '/');
    const safeParts = rawRel
      .split('/')
      .map((seg) => seg.replace(/[<>:"|?*]/g, '_').trim())
      .filter((seg) => seg && seg !== '.' && seg !== '..');
    const b64 = String((f as Record<string, unknown>).dataBase64 ?? '');
    if (!safeParts.length || !b64) continue;
    const dest = path.join(bundleAbs, ...safeParts);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, Buffer.from(b64, 'base64'));
    names.push(safeParts.join('/'));
  }
  if (!names.length) throw new Error('no valid files uploaded');
  return { bundleDir: bundleRel, count: names.length, names };
}

/**
 * Local dashboard server: static UI modules, JSON API, and SSE state stream.
 * Bound strictly to 127.0.0.1 with Host header allow-list and per-run CSRF token.
 */
export async function startUiServer(svc: Synergy, opts: UiOptions): Promise<UiServer> {
  let activeSvc = svc;
  let projectRev = 0;
  let lastBridgedEventId = svc.maxId();
  const shouldObserve = opts.observe ?? svc.db.name !== ':memory:';
  const isIsolated = opts.projectsFile !== undefined || svc.db.name === ':memory:' || opts.observe === false;
  const projFilePath = opts.projectsFile ?? (isIsolated ? path.join(svc.root, '.synergy', 'test-projects.json') : defaultProjectsFilePath());
  const stripTempProjects = !isIsolated;
  const observer = shouldObserve ? new LiveObserver() : null;
  let lastObsPoll = 0;
  const pollObserverThrottled = () => {
    const now = Date.now();
    if (observer && now - lastObsPoll >= 1500) {
      lastObsPoll = now;
      observer.poll();
    }
  };
  pollObserverThrottled();

  const token = crypto.randomBytes(16).toString('hex');
  const indexTpl = fs.readFileSync(path.join(opts.uiDir, 'index.html'), 'utf8');
  const clients = new Set<Client>();
  let port = 0;
  let usageCache: { key: string; data: { resetInMs: number; items: UsageItem[] } } = {
    key: '',
    data: { resetInMs: 0, items: [] },
  };
  const turnStats = new Map<string, { tokens: number; dur: number }>();

  const hostOk = (req: http.IncomingMessage) => {
    const h = req.headers.host ?? '';
    return h === `${HOST}:${port}` || h === `localhost:${port}`;
  };

  const currentProjectMeta = (): ProjectMeta => {
    const all = readProjects(projFilePath, activeSvc.root, stripTempProjects);
    return (
      all.find((p) => samePath(p.dir, activeSvc.root)) ?? {
        name: path.basename(activeSvc.root),
        dir: activeSvc.root,
        emoji: '🚀',
        color: '#ff8a3d',
      }
    );
  };

  const mergedState = (): StateSnapshot => {
    const state = activeSvc.state();
    if (!observer) return state;
    const obs = observer.snapshot();
    const byName = new Map<string, AgentView>(state.agents.map((a) => [a.name, { ...a }]));
    for (const oa of obs.agents) {
      const cur = byName.get(oa.name);
      if (!cur) {
        byName.set(oa.name, oa);
        continue;
      }
      cur.added = Math.max(cur.added, oa.added);
      cur.removed = Math.max(cur.removed, oa.removed);
      if (oa.status === 'working') cur.status = 'working';
      else if (cur.status === 'offline' && oa.status === 'idle') cur.status = 'idle';
      cur.last_seen = Math.max(cur.last_seen, oa.last_seen);
      if (oa.last_file) cur.last_file = oa.last_file;
      if (oa.last_summary) cur.last_summary = oa.last_summary;
    }
    return { ...state, agents: [...byName.values()] };
  };

  const snapshot = () => {
    const state = mergedState();
    const sig = JSON.stringify({
      a: state.agents.map((a) => [a.name, a.status, a.added, a.removed, a.last_file, a.last_summary]),
      l: state.locks.map((l) => [l.file, l.agent]),
      c: state.pendingCommands.map((c) => [c.id, c.status]),
      t: state.trustedAgents,
      r: state.pendingResearch.map((r) => [r.id, r.status]),
      p: state.pausedAgents,
      ro: state.roles.map((r) => [r.id, r.title, r.agent]),
      ch: [state.activeChatId, state.chats.map((c) => [c.id, c.title, c.archived, c.cleared_at, c.incognito, c.named_by, c.pinned, c.live_sessions])],
      pr: projectRev,
    });
    return { state, sig };
  };

  const sendSse = (c: Client, event: string, data: unknown, id?: number) => {
    c.res.write(`${id !== undefined ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const sendInit = (c: Client) => {
    pollObserverThrottled();
    const { state, sig } = snapshot();
    const obsSnap = observer?.snapshot();
    c.lastId = state.lastId;
    c.lastDiffId = activeSvc.maxDiffId();
    c.chatRev = activeSvc.chatRev();
    c.projectRev = projectRev;
    c.liveRev = obsSnap?.rev ?? 0;
    c.sig = sig;
    const projects = readProjects(projFilePath, activeSvc.root, stripTempProjects);
    const currentProject = currentProjectMeta();
    sendSse(c, 'init', {
      state,
      events: activeSvc.recentEvents(150),
      diffs: activeSvc.recentDiffs(40),
      liveTurns: obsSnap?.turns ?? [],
      liveSessions: obsSnap?.sessions ?? [],
      lang: activeSvc.getLang(),
      project: currentProject.name,
      root: activeSvc.root,
      currentProject,
      projects,
    });
  };

  const syncTurnStats = (turns: ReturnType<LiveObserver['snapshot']>['turns']) => {
    for (const t of turns) {
      const tok = Math.max(0, (t.tokensIn || 0) + (t.tokensOut || 0));
      const dur = t.finishedAt && t.startedAt ? Math.max(0, t.finishedAt - t.startedAt) : 0;
      const prev = turnStats.get(t.turnId) ?? { tokens: 0, dur: 0 };
      const dTok = Math.max(0, tok - prev.tokens);
      const dDur = Math.max(0, dur - prev.dur);
      if (dTok > 0 || dDur > 0) {
        accumulateAgentStats(t.agent, dTok, dDur);
        turnStats.set(t.turnId, { tokens: Math.max(prev.tokens, tok), dur: Math.max(prev.dur, dur) });
      }
    }
  };

  const bridgeAgentAsks = () => {
    if (!shouldObserve) return;
    const maxNow = activeSvc.maxId();
    if (maxNow <= lastBridgedEventId) {
      if (maxNow < lastBridgedEventId) lastBridgedEventId = maxNow;
      return;
    }
    const fresh = activeSvc.eventsSince(lastBridgedEventId);
    lastBridgedEventId = maxNow;
    const pausedSet = new Set(activeSvc.state().pausedAgents);
    const prefs = readAgentPrefs();
    for (const ev of fresh) {
      if (ev.type !== 'ask' || ev.agent === 'human' || ev.reply_to != null || !ev.to_agent) continue;
      if (ev.to_agent === 'human' || ev.to_agent === 'all') continue;
      const targets = ev.to_agent
        .split(',')
        .map((x) => x.trim())
        .filter((t) => t && !MCP_IDE_AGENTS.has(t) && t !== ev.agent && !pausedSet.has(t) && !prefs[t]?.disabled)
        .filter((t) => hasAgentApiKey(activeSvc.root, t) || t === 'ollama' || hasReadyAgentCli(t));
      if (!targets.length) continue;
      dispatchAgentMessage(targets, `[Message from ${ev.agent}]: ${ev.text}`, false, {
        replyTarget: ev.agent,
        replyTo: ev.id,
      });
    }
  };

  const tick = () => {
    bridgeAgentAsks();
    if (clients.size === 0) return;
    try {
      if (activeSvc.hasExpiredLocks()) activeSvc.sweepLocks();
      pollObserverThrottled();
      const { state, sig } = snapshot();
      const diffMax = activeSvc.maxDiffId();
      const chatRev = activeSvc.chatRev();
      const obsSnap = observer?.snapshot();
      const liveRev = obsSnap?.rev ?? 0;
      for (const c of clients) {
        if (state.lastId < c.lastId || diffMax < c.lastDiffId || chatRev !== c.chatRev || projectRev !== c.projectRev) {
          sendInit(c);
          continue;
        }
        if (state.lastId > c.lastId) {
          const events = activeSvc.eventsSince(c.lastId);
          if (events.length) {
            c.lastId = events[events.length - 1].id;
            sendSse(c, 'events', events, c.lastId);
          }
        }
        if (diffMax > c.lastDiffId) {
          const diffs = activeSvc.diffsSince(c.lastDiffId);
          if (diffs.length) {
            c.lastDiffId = diffs[diffs.length - 1].id;
            sendSse(c, 'diffs', diffs);
          }
        }
        if (liveRev !== c.liveRev) {
          c.liveRev = liveRev;
          const turns = obsSnap?.turns ?? [];
          if (shouldObserve) syncTurnStats(turns);
          sendSse(c, 'live', { turns, sessions: obsSnap?.sessions ?? [] });
        }
        if (sig !== c.sig) {
          c.sig = sig;
          sendSse(c, 'state', { state, lang: activeSvc.getLang() });
        }
      }
    } catch (e) {
      console.error('[masiva] ui tick error:', e);
    }
  };
  const scheduleTick = () => queueMicrotask(tick);

  async function handleGet(p: string, url: URL, req: http.IncomingMessage, res: http.ServerResponse) {
    if (p === '/' || p === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return void res.end(indexTpl.replace('__SYNERGY_TOKEN__', token));
    }
    if (tryServeStaticAsset(p, res, opts.uiDir, activeSvc.root)) return;
    if (p === '/api/project/sources') return json(res, 200, { sources: readProjectSources(activeSvc.root) });
    if (p === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 1000\n\n');
      const c: Client = { res, lastId: 0, lastDiffId: 0, chatRev: 0, projectRev, liveRev: 0, sig: '' };
      clients.add(c);
      sendInit(c);
      req.on('close', () => clients.delete(c));
      return;
    }
    if (p === '/api/state') {
      pollObserverThrottled();
      const currentProject = currentProjectMeta();
      return json(res, 200, {
        state: mergedState(),
        events: activeSvc.recentEvents(150),
        diffs: activeSvc.recentDiffs(40),
        liveTurns: observer?.snapshot().turns ?? [],
        liveSessions: observer?.snapshot().sessions ?? [],
        lang: activeSvc.getLang(),
        project: currentProject.name,
        root: activeSvc.root,
        currentProject,
        projects: readProjects(projFilePath, activeSvc.root, stripTempProjects),
      });
    }
    if (p === '/api/tree') return json(res, 200, { files: listProjectFiles(activeSvc.root) });
    if (p === '/api/fs/list') return json(res, 200, listFolders(url.searchParams.get('dir') ?? undefined));
    if (p === '/api/usage') {
      const cacheKey = `${projectRev}:${activeSvc.maxId()}:${activeSvc.maxDiffId()}:${observer?.snapshot().rev ?? 0}:${Math.floor(Date.now() / 5000)}`;
      if (usageCache.key !== cacheKey) usageCache = { key: cacheKey, data: collectUsageWindow(activeSvc, shouldObserve) };
      const total5h = usageCache.data.items.reduce((sum, u) => sum + (Number(u.tokens) || 0), 0);
      const profileStats = shouldObserve ? recordFiveHourTokens(total5h) : readProfileStats();
      return json(res, 200, { ...usageCache.data, profileStats });
    }
    if (p === '/api/settings/perplexity') return json(res, 200, perplexityKeyStatus(activeSvc.root));
    if (p === '/api/settings/api-keys') return json(res, 200, { keys: apiKeyStatusList(activeSvc.root) });
    if (p === '/api/skills') return json(res, 200, { skills: discoverSkills(activeSvc.root) });
    if (p === '/api/agents/prefs') return json(res, 200, { prefs: readAgentPrefs(), profileStats: readProfileStats() });
    if (p === '/api/agents/cli-status') return json(res, 200, { cli: await getCliStatusList() });
    if (p === '/api/agents/catalog') return json(res, 200, { agents: await getAgentCatalog(activeSvc.root) });
    if (p === '/api/memory') {
      const memory = readProjectMemory(activeSvc.root);
      const diffSummary = getGitDiffSummary(activeSvc.root, 3000);
      return json(res, 200, {
        memory,
        contextMarkdown: renderContextMarkdown(memory, activeSvc.state().locks, diffSummary),
        diffSummary,
        handoffBrief: buildHandoffBrief(activeSvc),
      });
    }
    if (p === '/api/ollama/status') return json(res, 200, await getOllamaRecommendation());
    if (p === '/api/mcp/setup') {
      const root = activeSvc.root;
      const entry = (ag: string) => ({
        command: 'npx',
        args: ['-y', 'synergy-mcp', 'serve', '--root', root],
        env: { SYNERGY_AGENT: ag },
      });
      return json(res, 200, {
        root,
        antigravity: { configPath: '~/.gemini/antigravity/mcp_config.json', json: { mcpServers: { synergy: entry('antigravity') } } },
        cursor: { configPath: '.cursor/mcp.json', json: { mcpServers: { synergy: entry('cursor') } } },
        claudeCode: {
          command: `claude mcp add synergy -e SYNERGY_AGENT=claude-code -- npx -y synergy-mcp serve --root "${root}"`,
        },
        gemini: { configPath: '~/.gemini/settings.json', json: { mcpServers: { synergy: entry('gemini') } } },
        codex: {
          configPath: '~/.codex/config.toml',
          toml: `[mcp_servers.synergy]\ncommand = "npx"\nargs = ["-y", "synergy-mcp", "serve", "--root", "${root.replace(/\\/g, '\\\\')}"]\nenv = { SYNERGY_AGENT = "codex" }`,
        },
      });
    }
    if (p === '/api/git/status') return json(res, 200, getGitStatus(activeSvc.root));
    if (p === '/api/workflow') return json(res, 200, readWorkflow(activeSvc.root));
    if (p === '/api/file') {
      const rel = normalizeFile(activeSvc.root, url.searchParams.get('path') ?? '');
      const abs = path.join(activeSvc.root, rel);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return json(res, 404, { error: 'file not found' });
      return json(res, 200, { path: rel, content: fs.readFileSync(abs, 'utf8').slice(0, 200_000) });
    }
    if (p === '/api/diff') return json(res, 200, { diffs: activeSvc.diffsForFile(url.searchParams.get('file') ?? '', 5) });
    json(res, 404, { error: 'not found' });
  }

  function dispatchAgentMessage(
    targets: string[],
    promptText: string,
    visualApproved: boolean,
    replyOpts?: { replyTarget?: string; replyTo?: number },
  ): string | undefined {
    const prefs = readAgentPrefs();
    const srcList = readProjectSources(activeSvc.root).map((s) => s.name);
    const srcNote = srcList.length ? ` Available project sources in .synergy/sources/: ${srcList.join(', ')}.` : '';
    const sharedCtx = buildSharedContextPrompt(activeSvc, { includeDiff: false, maxEvents: 8 });
    const mcpOnly: string[] = [];
    const unauthCli: string[] = [];

    for (const rawTarget of targets) {
      const target = normalizeAgent(rawTarget);
      if (MCP_IDE_AGENTS.has(target)) {
        mcpOnly.push(target);
        continue;
      }
      const hasKey = hasAgentApiKey(activeSvc.root, target);
      const isOllama = target === 'ollama';
      const readyCli = !hasKey && !isOllama && hasReadyAgentCli(target);
      if (!hasKey && !isOllama && !readyCli) {
        if (hasAgentCli(target)) unauthCli.push(target);
        else mcpOnly.push(target);
        continue;
      }
      const ap = prefs[target];
      const dirNote =
        (ap?.behavior ? ` Behavior rule: ${ap.behavior}.` : '') +
        (ap?.message ? ` User message to you: ${ap.message}.` : '');
      const sys =
        'Collaborate inside Masiva Labs. Summarize what you did or recommend in 2-3 clear lines so other agents can follow quickly.' +
        dirNote +
        srcNote +
        (visualApproved ? ' You may include a small self-contained visual snippet wrapped in [VISUAL]...[/VISUAL] HTML/SVG tags.' : '');

      const fullPrompt = sharedCtx ? `${sharedCtx}\n\nMESSAGE:\n${promptText}` : promptText;

      const deliver = (ans: string | null) => {
        if (!ans) return;
        try {
          activeSvc.askAgent({
            from: target,
            to: replyOpts?.replyTarget || 'human',
            question: ans,
            replyTo: replyOpts?.replyTo,
            preserveFull: true,
          });
          scheduleTick();
        } catch {
          /* ignore if store closed */
        }
      };

      runAgentUnified(activeSvc.root, target, fullPrompt, { systemPrompt: sys, mode: 'advisory' })
        .then((r) => deliver(r.ok ? r.reply ?? null : r.error ? `[${r.transport === 'cli' ? 'CLI Hatası' : 'Ajan Hatası'}] ${r.error}` : null))
        .catch(() => {});
    }

    const parts: string[] = [];
    if (unauthCli.length) {
      parts.push(`${unauthCli.join(', ')} CLI kurulu ancak giriş yapılmamış ve API anahtarı bağlı değil.`);
    }
    if (mcpOnly.length) {
      parts.push(`${mcpOnly.join(', ')} bir IDE MCP oturumudur; görev MCP gelen kutusuna bırakıldı (read_feed / handoff ile çekilir).`);
    }
    return parts.length ? parts.join(' ') : undefined;
  }

  async function handlePost(p: string, body: Record<string, unknown>, res: http.ServerResponse) {
    if (p === '/api/upload') return json(res, 200, { url: handleUploadImage(activeSvc.root, String(body.dataUrl ?? '')) });
    if (p === '/api/upload/bundle') {
      const files = Array.isArray(body.files) ? body.files : [];
      if (!files.length) return json(res, 400, { error: 'no files in folder/zip' });
      return json(res, 200, handleUploadBundle(activeSvc.root, files));
    }
    if (p === '/api/file/save') {
      const rel = normalizeFile(activeSvc.root, String(body.path ?? ''));
      const abs = path.join(activeSvc.root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, String(body.content ?? ''), 'utf8');
      return json(res, 200, { ok: true, path: rel });
    }
    if (p === '/api/message') {
      const text = String(body.text ?? '');
      const sent = activeSvc.humanSend(text, body.image ? String(body.image) : null);
      const ev = activeSvc.recentEvents(1)[0];
      let notice: string | undefined;
      if (ev?.to_agent && ev.to_agent !== 'all') {
        const targets = ev.to_agent.split(',').map((x) => x.trim()).filter(Boolean);
        notice = dispatchAgentMessage(targets, ev.text || text, Boolean(body.visualApproved));
      }
      return json(res, 200, notice ? { ...sent, notice } : sent);
    }
    if (p === '/api/message/edit') return json(res, 200, activeSvc.editHumanMessage(Number(body.id), String(body.text ?? '')));
    if (p === '/api/message/delete') return json(res, 200, activeSvc.deleteHumanMessage(Number(body.id)));
    if (p === '/api/message/recall-last') return json(res, 200, activeSvc.recallLastHumanMessage());
    if (p === '/api/chats/new') {
      return json(
        res,
        200,
        activeSvc.createChat({
          title: body.title ? String(body.title) : undefined,
          incognito: Boolean(body.incognito),
          participants: Array.isArray(body.participants) ? body.participants.map(String) : undefined,
          liveSessions: Array.isArray(body.liveSessions) ? body.liveSessions.map(String) : undefined,
        }),
      );
    }
    if (p === '/api/chats/bind-sessions') {
      const chatId = body.chatId ? Number(body.chatId) : activeSvc.activeChatId();
      const sessionIds = Array.isArray(body.sessionIds) ? body.sessionIds.map(String) : [];
      return json(res, 200, activeSvc.bindChatLiveSessions(chatId, sessionIds));
    }
    if (p === '/api/chats/switch') return json(res, 200, activeSvc.switchChat(Number(body.id)));
    if (p === '/api/chats/clear') return json(res, 200, { cleared: activeSvc.clearChat() });
    if (p === '/api/chats/archive') return json(res, 200, activeSvc.archiveChat(Number(body.id), Boolean(body.archived)));
    if (p === '/api/chats/purge-archived') return json(res, 200, { deleted: activeSvc.deleteAllArchivedChats() });
    if (p === '/api/chats/delete') return json(res, 200, { deleted: activeSvc.deleteChat(Number(body.id)) });
    if (p === '/api/chats/pin') return json(res, 200, activeSvc.pinChat(Number(body.id), Boolean(body.pinned)));
    if (p === '/api/chats/branch') return json(res, 200, activeSvc.branchChat(body.fromEventId ? Number(body.fromEventId) : undefined));
    if (p === '/api/agents/prefs') {
      return json(res, 200, {
        prefs: updateAgentPref(String(body.agent ?? ''), {
          customName: body.customName !== undefined ? String(body.customName) : undefined,
          disabled: body.disabled !== undefined ? Boolean(body.disabled) : undefined,
          behavior: body.behavior !== undefined ? String(body.behavior) : undefined,
          message: body.message !== undefined ? String(body.message) : undefined,
          selectedModel: body.selectedModel !== undefined ? String(body.selectedModel) : undefined,
          reasoningEffort: body.reasoningEffort !== undefined ? String(body.reasoningEffort) : undefined,
        }),
      });
    }
    if (p === '/api/agents/feedback') {
      const kind = body.kind === 'dislike' ? 'dislike' : 'like';
      const delta = Number(body.delta) === -1 ? -1 : 1;
      return json(res, 200, { prefs: recordAgentFeedback(String(body.agent ?? ''), kind, delta) });
    }
    if (p === '/api/agents/cli-setup') {
      const result = setupAgentCli(String(body.agent ?? ''));
      return json(res, 200, { ...result, cli: await getCliStatusList() });
    }
    if (p === '/api/project/pin') {
      const rawDir = String(body.dir ?? '').trim();
      if (!rawDir) return json(res, 400, { error: 'project dir is empty' });
      const resolved = path.resolve(rawDir);
      const list = readProjects(projFilePath, activeSvc.root, stripTempProjects)
        .map((pr) => (samePath(pr.dir, resolved) ? { ...pr, pinned: Boolean(body.pinned) } : pr))
        .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)));
      writeProjectsFile(projFilePath, list);
      projectRev++;
      return json(res, 200, { ok: true, projects: list });
    }
    if (p === '/api/project/sources/upload') {
      const files = Array.isArray(body.files) ? body.files : [];
      if (!files.length) return json(res, 400, { error: 'no files provided' });
      return json(res, 200, { sources: addProjectSources(activeSvc.root, files as Array<{ name?: unknown; dataBase64?: unknown }>) });
    }
    if (p === '/api/project/sources/delete') {
      return json(res, 200, { sources: removeProjectSource(activeSvc.root, String(body.name ?? '')) });
    }
    if (p === '/api/project/create') {
      const name = String(body.name ?? '').trim().slice(0, 60);
      if (!name) return json(res, 400, { error: 'project name is empty' });
      const safeSlug = name.replace(/[<>:"/\\|?*]/g, '-').trim() || 'project';
      const rawDir = String(body.dir ?? '').trim();
      const parentDir = String(body.parentDir ?? '').trim();
      const target = rawDir ? path.resolve(rawDir) : path.resolve(parentDir || path.dirname(activeSvc.root), safeSlug);
      const curProjs = readProjects(projFilePath, undefined, stripTempProjects);
      if (!curProjs.some((pr) => samePath(pr.dir, target)) && curProjs.length >= 100) {
        return json(res, 400, { error: 'project limit reached' });
      }
      fs.mkdirSync(target, { recursive: true });
      const files = Array.isArray(body.files) ? body.files : [];
      for (const f of files.slice(0, 20)) {
        if (!f || typeof f !== 'object') continue;
        const rawName = path.basename(String((f as Record<string, unknown>).name ?? '')).replace(/[<>:"/\\|?*]/g, '_');
        const b64 = String((f as Record<string, unknown>).dataBase64 ?? '');
        if (!rawName || rawName === '.' || rawName === '..' || !b64) continue;
        fs.writeFileSync(path.join(target, rawName), Buffer.from(b64, 'base64'));
      }
      const emoji = String(body.emoji ?? '🚀').slice(0, 8) || '🚀';
      const color = /^#[0-9a-fA-F]{6}$/.test(String(body.color ?? '')) ? String(body.color) : '#ff8a3d';
      activeSvc = new Synergy(openDb(dbPath(target)), { root: target });
      lastBridgedEventId = activeSvc.maxId();
      projectRev++;
      usageCache = { key: '', data: { resetInMs: 0, items: [] } };
      const meta: ProjectMeta = { name, dir: target, emoji, color };
      return json(res, 200, { ok: true, root: target, project: meta, projects: upsertProjectMeta(projFilePath, meta, stripTempProjects) });
    }
    if (p === '/api/project/open') {
      const rawDir = String(body.dir ?? '').trim();
      if (!rawDir) return json(res, 400, { error: 'project folder path is empty' });
      const resolved = path.resolve(rawDir);
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
        return json(res, 400, { error: 'folder does not exist' });
      }
      const existing = readProjects(projFilePath, undefined, stripTempProjects).find((pr) => samePath(pr.dir, resolved));
      const meta: ProjectMeta = {
        name: String(body.name ?? '').trim() || existing?.name || path.basename(resolved),
        dir: resolved,
        emoji: String(body.emoji ?? '').trim() || existing?.emoji || '🚀',
        color: /^#[0-9a-fA-F]{6}$/.test(String(body.color ?? '')) ? String(body.color) : existing?.color || '#ff8a3d',
      };
      activeSvc = new Synergy(openDb(dbPath(resolved)), { root: resolved });
      lastBridgedEventId = activeSvc.maxId();
      projectRev++;
      usageCache = { key: '', data: { resetInMs: 0, items: [] } };
      return json(res, 200, {
        ok: true,
        root: resolved,
        project: meta.name,
        currentProject: meta,
        projects: upsertProjectMeta(projFilePath, meta, stripTempProjects),
      });
    }
    if (p === '/api/project/archive') {
      const rawDir = String(body.dir ?? '').trim();
      const archived = Boolean(body.archived);
      if (!rawDir) return json(res, 400, { error: 'project dir is empty' });
      const resolved = path.resolve(rawDir);
      const base = readProjects(projFilePath, activeSvc.root, stripTempProjects);
      let matched = false;
      const list = base.map((pr) => (samePath(pr.dir, resolved) ? ((matched = true), { ...pr, archived }) : pr));
      if (!matched) {
        list.push({ name: path.basename(resolved) || resolved, dir: resolved, emoji: '🚀', color: '#ff8a3d', updatedAt: Date.now(), archived });
      }
      writeProjectsFile(projFilePath, list);
      let nextProj: ProjectMeta | null = null;
      if (archived && samePath(resolved, activeSvc.root)) {
        const candidate = list.find((pr) => !pr.archived && fs.existsSync(pr.dir) && fs.statSync(pr.dir).isDirectory());
        if (candidate) {
          activeSvc = new Synergy(openDb(dbPath(candidate.dir)), { root: candidate.dir });
          lastBridgedEventId = activeSvc.maxId();
          usageCache = { key: '', data: { resetInMs: 0, items: [] } };
          nextProj = candidate;
        }
      }
      projectRev++;
      return json(res, 200, { ok: true, projects: list, switched: Boolean(nextProj), root: activeSvc.root, currentProject: nextProj });
    }
    if (p === '/api/project/delete') {
      const rawDir = String(body.dir ?? '').trim();
      if (!rawDir) return json(res, 400, { error: 'project dir is empty' });
      const resolved = path.resolve(rawDir);
      const list = readProjects(projFilePath, activeSvc.root, stripTempProjects).filter((pr) => !samePath(pr.dir, resolved));
      writeProjectsFile(projFilePath, list);
      projectRev++;
      return json(res, 200, { ok: true, projects: list });
    }
    if (p === '/api/agent/pause') return json(res, 200, activeSvc.setAgentPaused(String(body.agent ?? ''), Boolean(body.paused)));
    if (p === '/api/settings/perplexity') return json(res, 200, savePerplexityKey(activeSvc.root, String(body.apiKey ?? '')));
    if (p === '/api/settings/api-keys') {
      const provider = String(body.provider ?? '');
      const apiKey = String(body.apiKey ?? '');
      if (provider.trim().toLowerCase() === 'perplexity') savePerplexityKey(activeSvc.root, apiKey);
      return json(res, 200, { keys: saveProviderApiKey(activeSvc.root, provider, apiKey) });
    }
    if (p === '/api/roles/create') {
      return json(
        res,
        200,
        activeSvc.createRole({
          title: String(body.title ?? ''),
          description: body.description ? String(body.description) : '',
          agent: body.agent ? String(body.agent) : null,
        }),
      );
    }
    if (p === '/api/roles/assign') return json(res, 200, activeSvc.assignRole(Number(body.id), body.agent ? String(body.agent) : null));
    if (p === '/api/roles/delete') return json(res, 200, { deleted: activeSvc.deleteRole(Number(body.id)) });
    if (p === '/api/mcp/install') {
      const client = String(body.client ?? '').trim().toLowerCase();
      if (client !== 'antigravity' && client !== 'cursor') {
        return json(res, 400, { error: 'desteklenen istemci: antigravity veya cursor' });
      }
      const configPath =
        client === 'antigravity'
          ? path.join(os.homedir(), '.gemini', 'antigravity', 'mcp_config.json')
          : path.join(activeSvc.root, '.cursor', 'mcp.json');
      let cur: Record<string, any> = {};
      try {
        if (fs.existsSync(configPath)) {
          const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
          if (parsed && typeof parsed === 'object') cur = parsed as Record<string, any>;
        }
      } catch {
        cur = {};
      }
      const prevServers = cur.mcpServers && typeof cur.mcpServers === 'object' ? cur.mcpServers : {};
      cur.mcpServers = {
        ...prevServers,
        synergy: {
          command: 'npx',
          args: ['-y', 'synergy-mcp', 'serve', '--root', activeSvc.root],
          env: { SYNERGY_AGENT: client },
        },
      };
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify(cur, null, 2) + '\n', 'utf8');
      return json(res, 200, { ok: true, client, configPath });
    }
    if (p === '/api/git/remote') return json(res, 200, setGitRemote(activeSvc.root, String(body.url ?? '')));
    if (p === '/api/git/auth') {
      saveGitHubAuth({
        token: body.token !== undefined ? String(body.token) : undefined,
        userName: body.userName !== undefined ? String(body.userName) : undefined,
        userEmail: body.userEmail !== undefined ? String(body.userEmail) : undefined,
      });
      return json(res, 200, getGitStatus(activeSvc.root));
    }
    if (p === '/api/git/logout') {
      clearGitHubAuth();
      return json(res, 200, getGitStatus(activeSvc.root));
    }
    if (p === '/api/git/commit') return json(res, 200, commitAndPush(activeSvc.root, String(body.message ?? ''), Boolean(body.push)));
    if (p === '/api/skills/create') {
      const scripts = Array.isArray(body.scripts) ? body.scripts.map((s: any) => ({ filename: String(s?.filename ?? ''), content: String(s?.content ?? '') })) : undefined;
      const references = Array.isArray(body.references) ? body.references.map((r: any) => ({ filename: String(r?.filename ?? ''), content: String(r?.content ?? '') })) : undefined;
      return json(res, 200, {
        skills: createSkill(activeSvc.root, {
          name: String(body.name ?? ''),
          description: String(body.description ?? ''),
          instructions: body.instructions ? String(body.instructions) : undefined,
          agent: body.agent ? String(body.agent) : null,
          scripts,
          references,
        }),
      });
    }
    if (p === '/api/agent/open') return json(res, 200, openAgentTarget(String(body.agent ?? '')));
    if (p === '/api/workflow/update') {
      return json(
        res,
        200,
        saveWorkflowPatch(activeSvc.root, {
          rules: body.rules !== undefined ? String(body.rules) : undefined,
          info: body.info !== undefined ? String(body.info) : undefined,
          running: body.running !== undefined ? Boolean(body.running) : undefined,
        }),
      );
    }
    if (p === '/api/workflow/task') {
      const action = String(body.action ?? 'add') as 'add' | 'delete' | 'clear_done';
      return json(
        res,
        200,
        mutateWorkflowTask(activeSvc.root, action, {
          id: body.id ? String(body.id) : undefined,
          title: body.title ? String(body.title) : undefined,
          agent: body.agent ? String(body.agent) : null,
        }),
      );
    }
    if (p === '/api/workflow/upload') {
      return json(
        res,
        200,
        addWorkflowAttachment(activeSvc.root, {
          name: String(body.name ?? 'file'),
          kind: body.kind === 'image' ? 'image' : 'file',
          dataBase64: String(body.dataBase64 ?? ''),
        }),
      );
    }
    if (p === '/api/unlock') return json(res, 200, { unlocked: activeSvc.forceUnlock(String(body.file ?? '')) });
    if (p === '/api/lang') {
      activeSvc.setLang(String(body.lang ?? ''));
      return json(res, 200, { lang: activeSvc.getLang() });
    }
    if (p === '/api/clear-agents') return json(res, 200, { cleared: activeSvc.clearAgents() });
    if (p === '/api/command/resolve') {
      const id = Number(body.id);
      const decision = String(body.decision ?? '') as 'allow' | 'deny' | 'always';
      const result = activeSvc.resolveCommand(id, decision);
      if (result.status === 'approved') {
        const cmd = activeSvc.db.prepare('SELECT * FROM commands WHERE id=?').get(id) as CommandRow | undefined;
        if (cmd && cmd.to_agent === 'perplexity') {
          const reqRow = activeSvc.queueResearch({ from: cmd.from_agent, query: cmd.command });
          if (readPerplexityKey(activeSvc.root)) {
            queryPerplexityApi(reqRow.query, undefined, activeSvc.root)
              .then((ans) => { if (ans) activeSvc.completeResearch(reqRow.id, ans); })
              .catch((err) => console.error('[masiva] perplexity error:', err));
          }
        }
      }
      return json(res, 200, result);
    }
    if (p === '/api/command/revoke') return json(res, 200, { revoked: activeSvc.revokeTrustedAgent(String(body.agent ?? '')) });
    if (p === '/api/research/reply') {
      const { eventId } = activeSvc.completeResearch(Number(body.id), String(body.report ?? ''));
      return json(res, 200, { ok: true, eventId });
    }
    if (p === '/api/memory/decision') {
      if (body.goal !== undefined) setProjectGoal(activeSvc.root, String(body.goal));
      const memory = body.text
        ? appendMemoryDecision(activeSvc.root, String(body.agent ?? 'human'), String(body.text))
        : readProjectMemory(activeSvc.root);
      return json(res, 200, { ok: true, memory, contextMarkdown: renderContextMarkdown(memory, activeSvc.state().locks) });
    }
    if (p === '/api/memory/handoff') {
      const to = normalizeAgent(String(body.to ?? ''));
      const from = normalizeAgent(String(body.from ?? 'human'));
      const goal = String(body.goal ?? '').trim();
      const files = Array.isArray(body.files) ? body.files.map(String) : [];
      const notes = body.notes ? String(body.notes) : '';
      const memory = recordHandoff(activeSvc.root, { from, to, goal, files, notes });
      const msg = `[HANDOFF] ${goal}${files.length ? ` [${files.join(', ')}]` : ''}${notes ? ` — ${notes}` : ''}`;
      const askOut = activeSvc.askAgent({ from, to, question: msg, preserveFull: true });
      const notice = MCP_IDE_AGENTS.has(to) ? undefined : dispatchAgentMessage([to], msg, false, { replyTarget: from });
      return json(res, 200, { ok: true, memory, ask: askOut, notice });
    }
    if (p === '/api/ollama/pull') {
      return json(res, 200, await pullOllamaModel(String(body.model ?? '')));
    }
    if (p === '/api/orchestrate') {
      const rawMode = String(body.mode ?? 'direct');
      const mode: OrchestrationMode =
        rawMode === 'debate' || rawMode === 'code_review' || rawMode === 'relay' ? rawMode : 'direct';
      const prompt = String(body.prompt ?? '').trim();
      const agents = Array.isArray(body.agents) ? body.agents.map(String).filter(Boolean) : [];
      if (!prompt) return json(res, 400, { error: 'orchestration prompt is empty' });
      if (!agents.length) return json(res, 400, { error: 'at least one runnable agent is required' });
      const allowWrite = Boolean(body.allowWrite);
      const mcpTarget = body.mcpTarget ? String(body.mcpTarget) : undefined;
      if (Boolean(body.sync)) {
        const result = await runOrchestration(activeSvc, { mode, prompt, agents, allowWrite, mcpTarget });
        scheduleTick();
        return json(res, 200, result);
      }
      runOrchestration(activeSvc, { mode, prompt, agents, allowWrite, mcpTarget })
        .then(() => scheduleTick())
        .catch((err) => console.error('[masiva] orchestrate error:', err));
      return json(res, 200, { ok: true, started: true, mode, agents });
    }
    json(res, 404, { error: 'not found' });
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (!hostOk(req)) return json(res, 403, { error: 'bad host' });
      const url = new URL(req.url ?? '/', `http://${HOST}:${port}`);
      const p = url.pathname;

      if (req.method === 'GET') return await handleGet(p, url, req, res);
      if (req.method === 'POST') {
        const origin = req.headers.origin;
        if (origin && origin !== `http://${req.headers.host}`) return json(res, 403, { error: 'bad origin' });
        if (req.headers['x-synergy-token'] !== token) return json(res, 403, { error: 'bad token' });
        res.on('finish', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) scheduleTick();
        });
        const body = await readBody(req, LARGE_BODY_ROUTES.has(p) ? MAX_UPLOAD_BODY : MAX_BODY);
        return await handlePost(p, body, res);
      }
      json(res, 405, { error: 'method not allowed' });
    } catch (e) {
      if (!res.headersSent) json(res, 400, { error: (e as Error).message });
      else res.end();
    }
  });

  const start = opts.port ?? 4777;
  await new Promise<void>((resolve, reject) => {
    let attempt = 0;
    const tryListen = () => {
      port = start + attempt;
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && opts.port === undefined && attempt < 20) {
          attempt++;
          tryListen();
        } else {
          reject(err);
        }
      });
      server.listen(port, HOST, () => {
        server.removeAllListeners('error');
        port = (server.address() as AddressInfo).port;
        resolve();
      });
    };
    tryListen();
  });

  const timer = setInterval(tick, opts.pollMs ?? 400);
  const wfTimer = setInterval(() => { stepWorkflowAutopilot(activeSvc).catch(() => {}); }, 8_000);
  const heartbeat = setInterval(() => { for (const c of clients) c.res.write(': hb\n\n'); }, 15_000);
  timer.unref();
  wfTimer.unref();
  heartbeat.unref();

  return {
    url: `http://${HOST}:${port}/`,
    port,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(timer);
        clearInterval(wfTimer);
        clearInterval(heartbeat);
        for (const c of clients) c.res.end();
        clients.clear();
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
