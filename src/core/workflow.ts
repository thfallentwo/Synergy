import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MCP_IDE_AGENTS, normalizeAgent } from './agents';
import { runAgentUnified, type UnifiedRunResult } from './apiRunner';
import { buildSharedContextPrompt } from './memory';
import type { Synergy } from './service';

export interface WorkflowTask {
  id: string;
  title: string;
  agent: string | null;
  status: 'pending' | 'running' | 'done' | 'failed';
  result?: string;
  ts: number;
}

export interface WorkflowFile {
  name: string;
  kind: 'image' | 'file';
  path: string;
  size: number;
  ts: number;
}

export interface WorkflowState {
  running: boolean;
  rules: string;
  info: string;
  tasks: WorkflowTask[];
  files: WorkflowFile[];
  updatedAt: number;
}

export const MAX_WORKFLOW_IMAGES = 50;
export const MAX_WORKFLOW_FILES = 25;
export const MAX_WORKFLOW_FILE_BYTES = 15_000_000;

function wfPath(root: string): string {
  return path.join(root, '.synergy', 'workflow.json');
}

function emptyWorkflow(): WorkflowState {
  return { running: false, rules: '', info: '', tasks: [], files: [], updatedAt: Date.now() };
}

/** Read persistent workflow state (`rules`, `info`, `tasks`, `files`, autopilot `running`). */
export function readWorkflow(root: string): WorkflowState {
  const file = wfPath(root);
  if (!fs.existsSync(file)) return emptyWorkflow();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<WorkflowState>;
    return {
      running: Boolean(parsed.running),
      rules: String(parsed.rules ?? ''),
      info: String(parsed.info ?? ''),
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
      files: Array.isArray(parsed.files) ? parsed.files : [],
      updatedAt: Number(parsed.updatedAt) || Date.now(),
    };
  } catch {
    return emptyWorkflow();
  }
}

function writeWorkflow(root: string, wf: WorkflowState): WorkflowState {
  wf.updatedAt = Date.now();
  const file = wfPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(wf, null, 2), 'utf8');
  return wf;
}

/** Update `rules`, `info`, or `running` autopilot state. */
export function saveWorkflowPatch(
  root: string,
  patch: Partial<Pick<WorkflowState, 'rules' | 'info' | 'running'>>,
): WorkflowState {
  const wf = readWorkflow(root);
  if (patch.rules !== undefined) wf.rules = String(patch.rules).slice(0, 8000);
  if (patch.info !== undefined) wf.info = String(patch.info).slice(0, 12000);
  if (patch.running !== undefined) wf.running = Boolean(patch.running);
  return writeWorkflow(root, wf);
}

/** Append or remove a task in the autonomous workflow queue. */
export function mutateWorkflowTask(
  root: string,
  action: 'add' | 'delete' | 'clear_done',
  input: { id?: string; title?: string; agent?: string | null },
): WorkflowState {
  const wf = readWorkflow(root);
  if (action === 'add') {
    const title = String(input.title ?? '').trim().slice(0, 200);
    if (!title) throw new Error('task title is empty');
    const agent = input.agent && input.agent.trim() ? normalizeAgent(input.agent) : null;
    wf.tasks.push({ id: `wf-${crypto.randomUUID().slice(0, 8)}`, title, agent, status: 'pending', ts: Date.now() });
  } else if (action === 'delete') {
    wf.tasks = wf.tasks.filter((t) => t.id !== String(input.id ?? ''));
  } else if (action === 'clear_done') {
    wf.tasks = wf.tasks.filter((t) => t.status !== 'done');
  }
  return writeWorkflow(root, wf);
}

/** Store a workflow image (max 50) or large attachment inside `.synergy/workflow-files/`. */
export function addWorkflowAttachment(
  root: string,
  input: { name: string; kind: 'image' | 'file'; dataBase64: string },
): WorkflowState {
  const wf = readWorkflow(root);
  if (input.kind === 'image') {
    if (wf.files.filter((f) => f.kind === 'image').length >= MAX_WORKFLOW_IMAGES) {
      throw new Error(`max ${MAX_WORKFLOW_IMAGES} images allowed in workflow`);
    }
  } else if (wf.files.filter((f) => f.kind === 'file').length >= MAX_WORKFLOW_FILES) {
    throw new Error(`max ${MAX_WORKFLOW_FILES} files allowed in workflow`);
  }

  const buf = Buffer.from(input.dataBase64, 'base64');
  if (!buf.length) throw new Error('empty file');
  if (buf.length > MAX_WORKFLOW_FILE_BYTES) throw new Error('file exceeds 15MB limit');

  const safeName = path.basename(input.name || 'file').replace(/[<>:"/\\|?*]/g, '_');
  const storedName = `${crypto.randomUUID().slice(0, 6)}_${safeName}`;
  const relPath = path.posix.join('.synergy', 'workflow-files', storedName);
  const absPath = path.join(root, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, buf);

  wf.files.push({ name: safeName, kind: input.kind, path: relPath, size: buf.length, ts: Date.now() });
  return writeWorkflow(root, wf);
}

let autopilotBusy = false;

/** Execute one pending workflow task when autopilot `running` is enabled. */
export async function stepWorkflowAutopilot(
  svc: Synergy,
  runnerFn: (
    root: string,
    agent: string,
    prompt: string,
    opts?: { systemPrompt?: string; mode?: 'advisory' | 'workspace_write'; timeoutMs?: number },
  ) => Promise<UnifiedRunResult> = runAgentUnified,
): Promise<boolean> {
  if (autopilotBusy) return false;
  const wf = readWorkflow(svc.root);
  if (!wf.running) return false;
  const next = wf.tasks.find((t) => t.status === 'pending');
  if (!next) return false;

  autopilotBusy = true;
  try {
    next.status = 'running';
    writeWorkflow(svc.root, wf);

    const targetAgent = next.agent || 'antigravity';
    const shared = buildSharedContextPrompt(svc, { includeDiff: false, maxEvents: 6 });
    const context =
      (shared ? `${shared}\n\n` : '') +
      (wf.rules ? `RULES:\n${wf.rules}\n\n` : '') +
      (wf.info ? `INFORMATION:\n${wf.info}\n\n` : '') +
      (wf.files.length ? `ATTACHED FILES (${wf.files.length}): ${wf.files.map((f) => f.path).join(', ')}\n\n` : '') +
      `AUTOPILOT TASK: ${next.title}`;

    const res = MCP_IDE_AGENTS.has(targetAgent)
      ? { ok: false, transport: 'none' as const }
      : await runnerFn(svc.root, targetAgent, context, {
          systemPrompt: 'You are executing an autonomous background Masiva Labs workflow task. Be clear and report concrete outcome.',
          mode: 'advisory',
        });

    const fresh = readWorkflow(svc.root);
    const taskRef = fresh.tasks.find((t) => t.id === next.id);
    if (res.ok && res.reply) {
      svc.postStatus({ agent: targetAgent, action: 'MODIFIED', file: '-', summary: res.reply.split(/\s+/).slice(0, 18).join(' ') });
      if (taskRef) {
        taskRef.status = 'done';
        taskRef.result = res.reply.slice(0, 400);
      }
    } else {
      svc.humanSend(`@${targetAgent} [WORKFLOW] ${next.title}`);
      if (taskRef) {
        taskRef.status = 'done';
        taskRef.result = `Dispatched to @${targetAgent} (MCP feed)`;
      }
    }
    writeWorkflow(svc.root, fresh);
    return true;
  } finally {
    autopilotBusy = false;
  }
}
