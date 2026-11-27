import crypto from 'node:crypto';
import { normalizeAgent } from './agents';
import { runAgentUnified, type UnifiedRunResult } from './apiRunner';
import { appendMemoryDecision, buildSharedContextPrompt, getGitDiffSummary, recordHandoff } from './memory';
import type { Synergy } from './service';

export type OrchestrationMode = 'direct' | 'debate' | 'code_review' | 'relay';

export interface OrchestrationTurn {
  round: number;
  role: string;
  agent: string;
  text: string;
  transport: string;
  error?: string;
}

export interface OrchestrationResult {
  runId: string;
  mode: OrchestrationMode;
  turns: OrchestrationTurn[];
  synthesis?: string;
  diffSummary?: string;
  handoffTo?: string;
}

export type UnifiedRunnerFn = (
  root: string,
  agent: string,
  prompt: string,
  opts?: { systemPrompt?: string; mode?: 'advisory' | 'workspace_write'; timeoutMs?: number },
) => Promise<UnifiedRunResult>;

const CONCISE_ROOM_RULE =
  'Keep your room update crisp and scannable (2-3 short lines summarizing what you did, changed, or decided so other agents can read it immediately; include code only when strictly required).';

function postRoomReply(svc: Synergy, from: string, to: string, text: string): void {
  try {
    svc.askAgent({ from, to, question: text, preserveFull: true });
  } catch {
    /* ignore store errors */
  }
}

/**
 * Run structured multi-agent collaboration pipelines (`direct`, `debate`, `code_review`, `relay`)
 * backed by shared project context and recorded into room events + project memory.
 */
export async function runOrchestration(
  svc: Synergy,
  input: {
    mode: OrchestrationMode;
    prompt: string;
    agents: string[];
    allowWrite?: boolean;
    mcpTarget?: string;
  },
  runnerFn: UnifiedRunnerFn = runAgentUnified,
): Promise<OrchestrationResult> {
  const prompt = String(input.prompt ?? '').trim();
  if (!prompt) throw new Error('orchestration prompt is empty');

  const agents = [...new Set((input.agents ?? []).map((a) => normalizeAgent(a)).filter((a) => a && a !== 'human' && a !== 'all'))];
  if (!agents.length) throw new Error('at least one runnable agent is required');

  const runId = `orc-${crypto.randomUUID().slice(0, 8)}`;
  const effectiveMode: OrchestrationMode = input.mode === 'debate' && agents.length < 2 ? 'direct' : input.mode;
  const sharedContext = buildSharedContextPrompt(svc, { includeDiff: true, maxEvents: 10 });
  const turns: OrchestrationTurn[] = [];

  if (effectiveMode === 'direct') {
    const ag = agents[0];
    const fullPrompt = `${sharedContext}\n\nUSER TASK:\n${prompt}`;
    const res = await runnerFn(svc.root, ag, fullPrompt, {
      systemPrompt: `You are collaborating inside Masiva Labs. Give a clear, complete engineering response grounded in the project context. ${CONCISE_ROOM_RULE}`,
      mode: input.allowWrite ? 'workspace_write' : 'advisory',
    });
    const text = res.ok && res.reply ? res.reply : `[Hata] ${res.error || 'Yanıt alınamadı'}`;
    turns.push({ round: 1, role: 'direct', agent: ag, text, transport: res.transport, error: res.ok ? undefined : res.error });
    postRoomReply(svc, ag, 'human', text);
    return { runId, mode: effectiveMode, turns };
  }

  if (effectiveMode === 'debate') {
    // Round 1: independent technical positions
    const r1Results = await Promise.all(
      agents.map(async (ag) => {
        const p1 = `${sharedContext}\n\nDEBATE TOPIC (Round 1):\n${prompt}\n\nState your concrete technical recommendation, trade-offs, and risks.`;
        const res = await runnerFn(svc.root, ag, p1, {
          systemPrompt: `Round 1 of multi-agent technical debate. Be concrete, concise, and opinionated. ${CONCISE_ROOM_RULE}`,
          mode: 'advisory',
        });
        const text = res.ok && res.reply ? res.reply : `[Hata] ${res.error || 'Yanıt alınamadı'}`;
        return { round: 1, role: 'stance', agent: ag, text, transport: res.transport, error: res.ok ? undefined : res.error };
      }),
    );
    for (const t of r1Results) {
      turns.push(t);
      postRoomReply(svc, t.agent, 'human', `[İstişare Tur 1] ${t.text}`);
    }

    // Round 2: cross-critique seeing all Round 1 answers
    const r1Transcript = r1Results.map((t) => `[${t.agent}]: ${t.text}`).join('\n\n');
    const r2Results = await Promise.all(
      agents.map(async (ag) => {
        const p2 = `${sharedContext}\n\nDEBATE TOPIC:\n${prompt}\n\nROUND 1 PROPOSALS:\n${r1Transcript}\n\nCritique blind spots in other agents' proposals and propose a converged final approach.`;
        const res = await runnerFn(svc.root, ag, p2, {
          systemPrompt: `Round 2 of multi-agent debate. Address disagreements and converge on actionable steps. ${CONCISE_ROOM_RULE}`,
          mode: 'advisory',
        });
        const text = res.ok && res.reply ? res.reply : `[Hata] ${res.error || 'Yanıt alınamadı'}`;
        return { round: 2, role: 'critique', agent: ag, text, transport: res.transport, error: res.ok ? undefined : res.error };
      }),
    );
    for (const t of r2Results) {
      turns.push(t);
      postRoomReply(svc, t.agent, 'human', `[İstişare Tur 2] ${t.text}`);
    }

    // Synthesis by the lead agent
    const lead = agents[0];
    const fullDebate = [...r1Results, ...r2Results].map((t) => `[Tur ${t.round} - ${t.agent}]: ${t.text}`).join('\n\n');
    const synthPrompt = `Synthesize the following multi-agent debate into a clear, actionable engineering decision:\n\nTOPIC: ${prompt}\n\n${fullDebate}`;
    const synthRes = await runnerFn(svc.root, lead, synthPrompt, {
      systemPrompt: `Produce a crisp synthesis and agreed action items. ${CONCISE_ROOM_RULE}`,
      mode: 'advisory',
    });
    const synthesis =
      synthRes.ok && synthRes.reply ? synthRes.reply : r2Results.map((t) => `${t.agent}: ${t.text.slice(0, 180)}`).join(' | ');
    postRoomReply(svc, lead, 'human', `[İstişare Özeti] ${synthesis}`);
    try {
      appendMemoryDecision(svc.root, lead, synthesis.slice(0, 400));
    } catch {
      /* ignore */
    }
    return { runId, mode: effectiveMode, turns, synthesis };
  }

  if (effectiveMode === 'code_review') {
    const coder = agents[0];
    const reviewer = agents[1];
    const coderPrompt = `${sharedContext}\n\nIMPLEMENTATION TASK:\n${prompt}\n\nRespect active file locks and summarize files/changes clearly.`;
    const codeRes = await runnerFn(svc.root, coder, coderPrompt, {
      systemPrompt: `You are the coder agent in a Code -> Review pipeline. Deliver concrete implementation changes/code. ${CONCISE_ROOM_RULE}`,
      mode: input.allowWrite ? 'workspace_write' : 'advisory',
    });
    const coderText = codeRes.ok && codeRes.reply ? codeRes.reply : `[Hata] ${codeRes.error || 'Kodlama yanıtı alınamadı'}`;
    turns.push({
      round: 1,
      role: 'coder',
      agent: coder,
      text: coderText,
      transport: codeRes.transport,
      error: codeRes.ok ? undefined : codeRes.error,
    });
    postRoomReply(svc, coder, 'human', `[Kodlama Çıktısı${reviewer ? ` -> ${reviewer}` : ''}] ${coderText}`);

    const diffSummary = getGitDiffSummary(svc.root, 2500);
    let reviewText = '';
    if (reviewer) {
      const reviewPrompt = `${sharedContext}\n\nORIGINAL TASK:\n${prompt}\n\nCODER (${coder}) OUTPUT:\n${coderText}\n\n${diffSummary ? `GIT DIFF:\n${diffSummary}\n\n` : ''}Audit the implementation for bugs, edge cases, regressions, and security issues.`;
      const revRes = await runnerFn(svc.root, reviewer, reviewPrompt, {
        systemPrompt: `You are the code reviewer agent. Report real bugs, edge cases, or PASS clearly. ${CONCISE_ROOM_RULE}`,
        mode: 'advisory',
      });
      reviewText = revRes.ok && revRes.reply ? revRes.reply : `[Hata] ${revRes.error || 'İnceleme yanıtı alınamadı'}`;
      turns.push({
        round: 2,
        role: 'reviewer',
        agent: reviewer,
        text: reviewText,
        transport: revRes.transport,
        error: revRes.ok ? undefined : revRes.error,
      });
      postRoomReply(svc, reviewer, 'human', `[İnceleme (${coder})] ${reviewText}`);
    }

    const synthesis = reviewText ? `Coder (${coder}): ${coderText.slice(0, 180)} | Review (${reviewer}): ${reviewText.slice(0, 220)}` : coderText.slice(0, 350);
    try {
      appendMemoryDecision(svc.root, reviewer ?? coder, synthesis);
    } catch {
      /* ignore */
    }

    let handoffTo: string | undefined;
    if (input.mcpTarget?.trim()) {
      handoffTo = normalizeAgent(input.mcpTarget);
      const summaryNotes = reviewText
        ? `Coder ${coder} tamamlandı; ${reviewer} incelemesi: ${reviewText.slice(0, 400)}`
        : `Coder ${coder} çıktısı hazır: ${coderText.slice(0, 400)}`;
      recordHandoff(svc.root, {
        from: reviewer ?? coder,
        to: handoffTo,
        goal: prompt,
        notes: summaryNotes,
      });
      postRoomReply(svc, reviewer ?? coder, handoffTo, `[HANDOFF] ${prompt} — ${summaryNotes}`);
    }

    return { runId, mode: effectiveMode, turns, synthesis, diffSummary: diffSummary || undefined, handoffTo };
  }

  // 'relay': each agent receives the accumulated output from previous steps
  let prevOutput = '';
  for (let i = 0; i < agents.length; i++) {
    const ag = agents[i];
    const relayPrompt =
      `${sharedContext}\n\nOVERALL GOAL:\n${prompt}` +
      (prevOutput ? `\n\nPREVIOUS AGENT (${agents[i - 1]}) HANDOFF:\n${prevOutput}` : '') +
      `\n\nYour turn (${i + 1}/${agents.length}): advance the solution cleanly.`;
    const res = await runnerFn(svc.root, ag, relayPrompt, {
      systemPrompt: `You are step ${i + 1} of ${agents.length} in a Masiva Labs agent relay. ${CONCISE_ROOM_RULE}`,
      mode: input.allowWrite ? 'workspace_write' : 'advisory',
    });
    const text = res.ok && res.reply ? res.reply : `[Hata] ${res.error || 'Yanıt alınamadı'}`;
    turns.push({
      round: i + 1,
      role: `relay-${i + 1}`,
      agent: ag,
      text,
      transport: res.transport,
      error: res.ok ? undefined : res.error,
    });
    postRoomReply(svc, ag, 'human', `[Relay ${i + 1}/${agents.length}${agents[i + 1] ? ` -> ${agents[i + 1]}` : ''}] ${text}`);
    if (res.ok && res.reply) prevOutput = res.reply;
  }
  const synthesis = prevOutput || turns[turns.length - 1]?.text;
  if (synthesis) {
    try {
      appendMemoryDecision(svc.root, agents[agents.length - 1], synthesis.slice(0, 400));
    } catch {
      /* ignore */
    }
  }
  return { runId, mode: effectiveMode, turns, synthesis };
}
