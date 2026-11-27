import { describe, expect, it } from 'vitest';
import { createSkill } from '../src/core/customization';
import { getGitStatus } from '../src/core/git';
import { resolveAgentLaunchTarget } from '../src/core/launcher';
import { summarizeFinalText } from '../src/core/liveObserver';
import { Synergy } from '../src/core/service';
import { addWorkflowAttachment, mutateWorkflowTask, readWorkflow, saveWorkflowPatch, stepWorkflowAutopilot } from '../src/core/workflow';
import { openDb } from '../src/core/store';
import { memSynergy, tmpRoot } from './helpers';

describe('post_status', () => {
  it('stores and returns an id; trims long summaries', () => {
    const { svc } = memSynergy();
    const long = Array.from({ length: 25 }, (_, i) => `w${i}`).join(' ');
    const out = svc.postStatus({ agent: 'claude', action: 'modified', file: 'src/auth.ts', summary: long });
    expect(out).toMatch(/^OK #1 \(trimmed to 20w\)/);
    expect(svc.recentEvents()[0].text.split(' ')).toHaveLength(20);
  });
  it('rejects bad action, empty summary, outside paths', () => {
    const { svc } = memSynergy();
    expect(() => svc.postStatus({ agent: 'a', action: 'NOPE', file: 'a', summary: 'x' })).toThrow(/action/);
    expect(() => svc.postStatus({ agent: 'a', action: 'INFO', file: 'a', summary: ' ' })).toThrow(/empty/);
    expect(() => svc.postStatus({ agent: 'a', action: 'INFO', file: '../a', summary: 'x' })).toThrow(/outside/);
  });
  it('allows no file and accumulates line counts', () => {
    const { svc } = memSynergy();
    svc.postStatus({ agent: 'claude', action: 'INFO', file: '-', summary: 'hi', added: 10, removed: 2 });
    svc.postStatus({ agent: 'claude', action: 'MODIFIED', file: 'a.ts', summary: 'x', added: 5, removed: 1 });
    const a = svc.state().agents[0];
    expect([a.added, a.removed, a.last_file]).toEqual([15, 3, 'a.ts']);
  });
  it('warns when the file is locked by another agent', () => {
    const { svc } = memSynergy();
    svc.lockFile({ agent: 'cursor', file: 'a.ts' });
    expect(svc.postStatus({ agent: 'claude', action: 'MODIFIED', file: 'a.ts', summary: 'x' })).toContain('WARN a.ts is locked by cursor');
  });
});

describe('locks', () => {
  it('grants, denies others, renews own', () => {
    const { svc, clock } = memSynergy();
    expect(svc.lockFile({ agent: 'claude', file: 'a.ts' })).toMatch(/^OK a\.ts locked 10m/);
    clock.advance(180_000);
    expect(svc.lockFile({ agent: 'cursor', file: 'a.ts' })).toMatch(/^DENIED a\.ts held by claude 3m, expires in 7m/);
    expect(svc.lockFile({ agent: 'claude', file: './a.ts' })).toMatch(/^OK a\.ts renewed/);
  });
  it('expires and tells the room', () => {
    const { svc, clock } = memSynergy({ ttl: 60_000 });
    svc.lockFile({ agent: 'claude', file: 'a.ts' });
    clock.advance(61_000);
    expect(svc.lockFile({ agent: 'cursor', file: 'a.ts' })).toMatch(/^OK a\.ts locked/);
    expect(svc.recentEvents().some((e) => e.type === 'system' && /expired/.test(e.text))).toBe(true);
  });
  it('only the owner unlocks; unlocking free file is ok', () => {
    const { svc } = memSynergy();
    svc.lockFile({ agent: 'claude', file: 'a.ts' });
    expect(svc.unlockFile({ agent: 'cursor', file: 'a.ts' })).toMatch(/^DENIED a\.ts held by claude/);
    expect(svc.unlockFile({ agent: 'claude', file: 'a.ts' })).toMatch(/^OK a\.ts unlocked/);
    expect(svc.unlockFile({ agent: 'claude', file: 'a.ts' })).toMatch(/^OK a\.ts not locked/);
  });
  it('releases all locks of an agent', () => {
    const { svc } = memSynergy();
    svc.lockFile({ agent: 'claude', file: 'a.ts' });
    svc.lockFile({ agent: 'claude', file: 'b.ts' });
    expect(svc.releaseAgentLocks('Claude')).toBe(2);
    expect(svc.state().locks).toHaveLength(0);
  });
  it('human /lock and /unlock', () => {
    const { svc } = memSynergy();
    svc.humanSend('/lock config.ts');
    expect(svc.lockFile({ agent: 'claude', file: 'config.ts' })).toMatch(/DENIED config\.ts held by human/);
    svc.humanSend('/unlock config.ts');
    expect(svc.lockFile({ agent: 'claude', file: 'config.ts' })).toMatch(/^OK/);
  });
});

describe('feed + digest', () => {
  it('piggybacks unread messages on any tool reply, once', () => {
    const { svc } = memSynergy();
    svc.readFeed({ agent: 'cursor' }); // register cursor
    svc.postStatus({ agent: 'claude', action: 'MODIFIED', file: 'a.ts', summary: 'Added role' });
    const out = svc.lockFile({ agent: 'cursor', file: 'b.ts' });
    expect(out).toContain('NEW(1):');
    expect(out).toContain('claude MODIFIED a.ts | Added role');
    expect(svc.unlockFile({ agent: 'cursor', file: 'b.ts' })).not.toContain('NEW');
  });
  it('does not echo your own events and caps the digest', () => {
    const { svc } = memSynergy();
    svc.readFeed({ agent: 'cursor' });
    for (let i = 0; i < 14; i++) svc.postStatus({ agent: 'claude', action: 'INFO', file: '-', summary: `m${i}` });
    const out = svc.postStatus({ agent: 'cursor', action: 'INFO', file: '-', summary: 'mine' });
    expect(out).toContain('NEW(14):');
    expect(out).toContain('(+4 older, call read_feed)');
    expect(out).not.toContain('cursor INFO');
  });
  it('read_feed shows latest N plus locks', () => {
    const { svc } = memSynergy();
    expect(svc.readFeed({ agent: 'claude' })).toBe('FEED: empty\nLOCKS: none');
    svc.lockFile({ agent: 'claude', file: 'a.ts' });
    svc.postStatus({ agent: 'claude', action: 'MODIFIED', file: 'a.ts', summary: 'x' });
    const out = svc.readFeed({ agent: 'cursor', limit: 1 });
    expect(out.split('\n')).toHaveLength(2);
    expect(out).toContain('claude MODIFIED a.ts | x');
    expect(out).toContain('LOCKS: a.ts@claude(0s)');
  });
});

describe('ask + human', () => {
  it('directed questions reach only the target (and read_feed)', () => {
    const { svc } = memSynergy();
    svc.readFeed({ agent: 'claude' });
    svc.readFeed({ agent: 'gemini' });
    svc.askAgent({ from: 'cursor', to: 'Claude', question: 'Is role optional?' });
    expect(svc.postStatus({ agent: 'claude', action: 'INFO', file: '-', summary: 'ok' })).toContain('cursor\u2192claude ? Is role optional?');
    expect(svc.postStatus({ agent: 'gemini', action: 'INFO', file: '-', summary: 'ok' })).not.toContain('Is role optional');
    expect(svc.readFeed({ agent: 'gemini' })).toContain('Is role optional');
  });
  it('replies carry reply_to; "all" reaches everyone', () => {
    const { svc } = memSynergy();
    const id = svc.askAgent({ from: 'cursor', to: 'all', question: 'anyone on db?' });
    expect(id).toMatch(/^OK #1/);
    svc.askAgent({ from: 'claude', to: 'cursor', question: 'no', replyTo: 1 });
    expect(svc.readFeed({ agent: 'cursor' })).toContain('re#1');
  });
  it('human broadcast and @mention', () => {
    const { svc } = memSynergy();
    svc.readFeed({ agent: 'claude' });
    svc.readFeed({ agent: 'cursor' });
    svc.humanSend('@claude finish auth first');
    svc.humanSend('everyone pause');
    expect(svc.postStatus({ agent: 'claude', action: 'INFO', file: '-', summary: 'k' })).toContain('[Human]\u2192claude ! finish auth first');
    const c = svc.postStatus({ agent: 'cursor', action: 'INFO', file: '-', summary: 'k' });
    expect(c).toContain('[Human] ! everyone pause');
    expect(c).not.toContain('finish auth first');
    expect(() => svc.humanSend('  ')).toThrow();
  });
});

describe('state', () => {
  it('derives status from activity and locks; hides human', () => {
    const { svc, clock } = memSynergy();
    svc.humanSend('hi');
    svc.lockFile({ agent: 'claude', file: 'a.ts' });
    svc.readFeed({ agent: 'cursor' });
    expect(svc.state().agents.map((a) => [a.name, a.status])).toEqual([['claude', 'working'], ['cursor', 'working']]);
    clock.advance(5 * 60_000);
    expect(svc.state().agents.map((a) => [a.name, a.status])).toEqual([['claude', 'working'], ['cursor', 'idle']]);
    clock.advance(10 * 60_000); // lock expired (10m ttl), claude idle too
    expect(svc.state().agents.map((a) => a.status)).toEqual(['offline', 'offline']);
  });
  it('prunes old events', () => {
    const { svc } = memSynergy();
    const small = new (svc.constructor as any)(svc.db, { root: '/proj', maxEvents: 3 });
    for (let i = 0; i < 6; i++) small.postStatus({ agent: 'a', action: 'INFO', file: '-', summary: `m${i}` });
    small.prune();
    expect(small.recentEvents(100).map((e: any) => e.text)).toEqual(['m3', 'm4', 'm5']);
  });

  it('clears agents without removing human', () => {
    const { svc } = memSynergy();
    svc.humanSend('hello');
    svc.readFeed({ agent: 'claude' });
    svc.readFeed({ agent: 'cursor' });
    expect(svc.state().agents).toHaveLength(2);
    expect(svc.clearAgents()).toBe(2);
    expect(svc.state().agents).toHaveLength(0);
  });
});

describe('commands & approvals', () => {
  it('queues pending commands and supports deny, allow, always, and revoke', () => {
    const { svc } = memSynergy();
    svc.readFeed({ agent: 'claude' });

    // 1. Denied command does not reach target events
    expect(svc.sendCommand({ from: 'cursor', to: 'claude', command: 'delete db' })).toMatch(/^PENDING cmd#1/);
    expect(svc.state().pendingCommands).toHaveLength(1);
    expect(svc.resolveCommand(1, 'deny')).toEqual({ status: 'denied' });
    expect(svc.state().pendingCommands).toHaveLength(0);
    expect(svc.postStatus({ agent: 'claude', action: 'INFO', file: '-', summary: 'hi' })).not.toContain('delete db');

    // 2. Allowed once delivers command to target
    expect(svc.sendCommand({ from: 'cursor', to: 'claude', command: 'check types' })).toMatch(/^PENDING cmd#2/);
    expect(svc.resolveCommand(2, 'allow').status).toBe('approved');
    expect(svc.postStatus({ agent: 'claude', action: 'INFO', file: '-', summary: 'ok' })).toContain('cursor\u2192claude CMD: check types');

    // 3. Always allow trusts sender for subsequent commands until revoked
    expect(svc.sendCommand({ from: 'cursor', to: 'claude', command: 'run lint' })).toMatch(/^PENDING cmd#3/);
    expect(svc.resolveCommand(3, 'always').status).toBe('approved');
    expect(svc.state().trustedAgents).toEqual(['cursor']);
    expect(svc.sendCommand({ from: 'cursor', to: 'claude', command: 'run build' })).toMatch(/^OK #\d+ \(auto-approved\)/);
    expect(svc.state().pendingCommands).toHaveLength(0);

    expect(svc.revokeTrustedAgent('cursor')).toBe(true);
    expect(svc.state().trustedAgents).toEqual([]);
    expect(svc.sendCommand({ from: 'cursor', to: 'claude', command: 'need approval again' })).toMatch(/^PENDING cmd#5/);
  });

  it('queues and completes Perplexity research requests', () => {
    const { svc } = memSynergy();
    const req = svc.queueResearch({ from: 'codex', query: 'Check X brand trademark status' });
    expect(req.id).toBe(1);
    expect(svc.state().pendingResearch).toHaveLength(1);
    const done = svc.completeResearch(req.id, 'X brand trademark is registered in class 9 and 42.');
    expect(done.eventId).toBeGreaterThan(1);
    expect(svc.state().pendingResearch).toHaveLength(0);
    expect(svc.readFeed({ agent: 'codex' })).toContain('perplexity\u2192codex re#' + req.askEventId);
  });

  it('edits and recalls human messages', () => {
    const { svc } = memSynergy();
    const { id } = svc.humanSend('@claude old text');
    svc.editHumanMessage(id, '@cursor updated text');
    expect(svc.recentEvents().find((e) => e.id === id)).toMatchObject({ to_agent: 'cursor', text: 'updated text' });
    const recalled = svc.deleteHumanMessage(id);
    expect(recalled).toMatchObject({ ok: true, text: '@cursor updated text' });
    expect(svc.recentEvents().some((e) => e.id === id)).toBe(false);
  });

  it('supports per-agent pause/resume and recalling last human message', () => {
    const { svc } = memSynergy();
    svc.setAgentPaused('gemini', true);
    expect(svc.state().pausedAgents).toEqual(['gemini']);
    expect(svc.recentEvents().at(-1)).toMatchObject({ type: 'human', to_agent: 'gemini', text: 'PAUSE: stop editing and wait for the human.' });
    svc.setAgentPaused('gemini', false);
    expect(svc.state().pausedAgents).toEqual([]);

    svc.humanSend('first');
    svc.humanSend('second');
    expect(svc.recallLastHumanMessage()).toMatchObject({ ok: true, text: 'second' });
    expect(svc.recallLastHumanMessage()).toMatchObject({ ok: true, text: 'first' });
  });

  it('creates, assigns, exposes in readFeed, and deletes custom roles', () => {
    const { svc } = memSynergy();
    const custom = svc.createRole({ title: 'Test Uzmanı', description: 'Sadece test yazar', agent: 'cursor' });
    expect(svc.state().agents.some((a) => a.name === 'cursor')).toBe(false);
    expect(svc.readFeed({ agent: 'cursor' })).toContain('ROLE: Test Uzmanı — Sadece test yazar');
    svc.assignRole(custom.id, 'deepseek');
    expect(svc.readFeed({ agent: 'deepseek' })).toContain('ROLE: Test Uzmanı');
    expect(svc.deleteRole(custom.id)).toBe(true);
  });

  it('supports creating, switching, clearing, and deleting chats', () => {
    const { svc } = memSynergy();
    svc.humanSend('in main');
    const c2 = svc.createChat('Feature Branch');
    expect(svc.activeChatId()).toBe(c2.id);
    expect(svc.recentEvents()).toHaveLength(0);
    svc.humanSend('in c2');
    expect(svc.recentEvents()).toHaveLength(1);
    expect(svc.clearChat()).toBe(1);
    expect(svc.recentEvents()).toHaveLength(0);
    svc.switchChat(1);
    expect(svc.recentEvents().map((e) => e.text)).toEqual(['in main']);
    expect(svc.deleteChat(c2.id)).toBe(true);
  });

  it('archives, restores, and purges archived chats', () => {
    const { svc } = memSynergy();
    const c2 = svc.createChat('Old Sprint');
    svc.humanSend('archived msg');
    svc.archiveChat(c2.id, true);
    expect(svc.activeChatId()).not.toBe(c2.id);
    expect(svc.listChats().find((c) => c.id === c2.id)?.archived).toBe(1);
    expect(svc.deleteAllArchivedChats()).toBe(1);
    expect(svc.listChats().some((c) => c.id === c2.id)).toBe(false);
  });

  it('updates cleared_at on clearChat and deduplicates empty New Chat creation', () => {
    const { svc, clock } = memSynergy();
    clock.advance(100);
    const n1 = svc.createChat();
    const n2 = svc.createChat();
    expect(n2.id).toBe(n1.id);

    svc.humanSend('first msg');
    clock.advance(100);
    const n3 = svc.createChat();
    expect(n3.id).not.toBe(n1.id);
    const n4 = svc.createChat();
    expect(n4.id).toBe(n3.id);

    svc.humanSend('in n3');
    const beforeClear = n3.cleared_at ?? 0;
    clock.advance(100);
    expect(svc.clearChat()).toBe(1);
    const afterClear = svc.listChats().find((c) => c.id === n3.id)?.cleared_at ?? 0;
    expect(afterClear).toBeGreaterThan(beforeClear);
  });

  it('compresses long live output to 2-3 summary lines', () => {
    const raw = '# Title\n\nLine one summary.\nLine two summary.\n```ts\nconst huge = 1;\n```\nLine three.\nLine four ignored.\nLine five ignored.';
    const out = summarizeFinalText(raw);
    expect(out.split('\n').length).toBeLessThanOrEqual(3);
    expect(out).not.toContain('const huge');
  });

  it('supports incognito 24h auto-expire, no-memory instruction, multi-@ slash commands, and auto-naming', () => {
    const { svc, clock } = memSynergy();
    const incog = svc.createChat({ incognito: true, participants: ['claude', 'gemini'] });
    expect(incog.incognito).toBe(1);
    expect(svc.readFeed({ agent: 'claude' })).toContain('INCOGNITO CHAT');
    expect(() => svc.archiveChat(incog.id, true)).toThrow(/incognito/);

    // /think requires topic; /image requires image-capable AI
    expect(() => svc.humanSend('@claude /think')).toThrow(/what to think/);
    expect(() => svc.humanSend('@claude /image draw logo')).toThrow(/image-capable/);
    svc.humanSend('@claude @gemini /goal Fix login race condition cleanly');

    const updated = svc.listChats().find((c) => c.id === incog.id)!;
    expect(updated.title).not.toBe('Incognito Chat');
    expect(['claude', 'gemini']).toContain(updated.named_by);
    const lastEv = svc.recentEvents().slice(-1)[0];
    expect(lastEv.to_agent).toBe('claude,gemini');
    expect(lastEv.text).toContain('[GOAL]');

    // Direct search + image-capable @gemini works
    svc.humanSend('@gemini /search Latest Node LTS features');
    expect(svc.recentEvents().slice(-1)[0].text).toContain('[SEARCH]');
    svc.humanSend('@gemini /image minimal neon logo');
    expect(svc.recentEvents().slice(-1)[0].text).toContain('[IMAGE]');

    // 24 hours later -> incognito chat disappears automatically
    clock.advance(24 * 60 * 60_000 + 1);
    expect(svc.listChats().some((c) => c.id === incog.id)).toBe(false);
  });

  it('creates custom skills with 20-char name limit and inspects git status safely', () => {
    const root = tmpRoot();
    expect(() => createSkill(root, { name: 'a'.repeat(21), description: 'too long' })).toThrow(/1-20/);
    const skills = createSkill(root, { name: 'auth-guard', description: 'Checks OAuth & JWT security.', agent: 'claude' });
    const added = skills.find((s) => s.name === 'auth-guard');
    expect(added).toMatchObject({ name: 'auth-guard', source: 'workspace', agent: 'claude' });

    const gs = getGitStatus(root);
    expect(gs.isRepo).toBe(false);
  });

  it('prunes unused empty New Chat drafts when switching to another chat', () => {
    const { svc } = memSynergy();
    svc.humanSend('in main chat');
    const draft = svc.createChat();
    expect(draft.title).toBe('New Chat');
    expect(svc.listChats().find((c) => c.id === 1)?.event_count).toBe(1);

    svc.switchChat(1);
    expect(svc.listChats().some((c) => c.id === draft.id)).toBe(false);
  });

  it('manages workflow rules, info, 50-image cap, autopilot step, and launcher targets', async () => {
    const root = tmpRoot();
    const svc = new Synergy(openDb(':memory:'), { root });
    saveWorkflowPatch(root, { rules: 'Keep functions tiny', info: 'Project notes', running: true });
    mutateWorkflowTask(root, 'add', { title: 'Audit login flow', agent: 'claude' });
    const b64 = Buffer.from('fakeimg').toString('base64');
    for (let i = 0; i < 50; i++) addWorkflowAttachment(root, { name: `img${i}.png`, kind: 'image', dataBase64: b64 });
    expect(() => addWorkflowAttachment(root, { name: 'img51.png', kind: 'image', dataBase64: b64 })).toThrow(/50/);

    const ran = await stepWorkflowAutopilot(svc, async () => ({ ok: false, transport: 'none' }));
    expect(ran).toBe(true);
    expect(readWorkflow(root).tasks[0].status).toBe('done');
    expect(svc.recentEvents().at(-1)?.text).toContain('[WORKFLOW]');

    expect(resolveAgentLaunchTarget('deepseek').url).toContain('deepseek.com');
  });
});
