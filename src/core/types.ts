export type EventType = 'status' | 'lock' | 'unlock' | 'ask' | 'command' | 'human' | 'system';

export type CommandStatus = 'pending' | 'approved' | 'denied';

export interface CommandRow {
  id: number;
  ts: number;
  from_agent: string;
  to_agent: string;
  command: string;
  status: CommandStatus;
}

export interface ResearchRow {
  id: number;
  ts: number;
  from_agent: string;
  query: string;
  ask_event_id: number;
  status: 'pending' | 'done';
}

export interface UsageItem {
  agent: string;
  display: string;
  kind: string;
  percent: number;
  tokens: number;
  ops: number;
  label: string;
  source: 'logs' | 'session';
}

export interface EventRow {
  id: number;
  ts: number;
  agent: string;
  type: EventType;
  action: string | null;
  file: string | null;
  text: string;
  to_agent: string | null;
  reply_to: number | null;
  added: number;
  removed: number;
  image?: string | null;
  chat_id?: number;
}

export interface LockRow {
  file: string;
  agent: string;
  ts: number;
  expires_at: number;
}

export interface AgentRow {
  name: string;
  display: string;
  kind: string;
  first_seen: number;
  last_seen: number;
  last_file: string | null;
  last_summary: string | null;
  read_cursor: number;
  added: number;
  removed: number;
  image?: string | null;
  chat_id?: number;
}

export type AgentStatus = 'working' | 'idle' | 'offline';

export interface AgentView extends AgentRow {
  status: AgentStatus;
}

export interface RoleRow {
  id: number;
  title: string;
  description: string;
  agent: string | null;
  ts: number;
}

export interface ChatRow {
  id: number;
  title: string;
  created_at: number;
  updated_at: number;
  archived?: number;
  cleared_at?: number;
  incognito?: number;
  expires_at?: number | null;
  participants?: string | null;
  named_by?: string | null;
  pinned?: number;
  live_sessions?: string | null;
  event_count?: number;
}

export interface LiveSessionInfo {
  sessionId: string;
  agent: string;
  title: string;
  updatedAt: number;
  turnCount: number;
  active: boolean;
}

export interface ProfileStats {
  record5hTokens: number;
  record5hAt: number;
}

export interface ApiKeyEntry {
  provider: string;
  label: string;
  configured: boolean;
  masked: string;
}

export interface SkillInfo {
  name: string;
  description: string;
  source: 'workspace' | 'user' | 'builtin';
  agent?: string | null;
  scriptCount?: number;
  refCount?: number;
}

export interface AgentPrefEntry {
  customName?: string;
  disabled?: boolean;
  behavior?: string;
  message?: string;
  selectedModel?: string;
  reasoningEffort?: string;
  totalTokens: number;
  totalWorkMs: number;
  likes: number;
  dislikes: number;
}

export type AgentPrefsMap = Record<string, AgentPrefEntry>;

export interface MeetingMessage {
  id: number;
  from: string;
  text: string;
  ts: number;
  accepted?: boolean;
}

export interface MeetingHand {
  agent: string;
  reason?: string;
  ts: number;
}

export interface MeetingNote {
  id: number;
  author: string;
  text: string;
  ts: number;
}

export interface MeetingProposal {
  by: string;
  reason: string;
  ts: number;
}

export interface MeetingState {
  id: string;
  title: string;
  startedBy: string;
  startedAt: number;
  status: 'active' | 'ended';
  endedAt?: number;
  seats: string[];
  floorAgent: string | null;
  handsRaised: MeetingHand[];
  mutedAgents: string[];
  deafAgents: string[];
  messages: MeetingMessage[];
  notes: MeetingNote[];
  savedFile?: string;
}

export interface MeetingFileInfo {
  file: string;
  title: string;
  date: string;
  mtime: number;
}

export interface ProjectMeta {
  name: string;
  dir: string;
  emoji: string;
  color: string;
  updatedAt?: number;
  archived?: boolean;
  pinned?: boolean;
}

export interface LiveStep {
  id: string;
  ts: number;
  agent: string;
  turnId: string;
  kind: 'focus' | 'read' | 'edit' | 'cmd' | 'research' | 'think';
  label: string;
  detail?: string;
  file?: string;
  added?: number;
  removed?: number;
}

export interface LiveTurn {
  turnId: string;
  agent: string;
  model?: string;
  sessionId?: string;
  sessionTitle?: string;
  startedAt: number;
  finishedAt?: number;
  status: 'working' | 'done';
  steps: LiveStep[];
  finalText?: string;
  tokensIn: number;
  tokensOut: number;
}

export interface StateSnapshot {
  agents: AgentView[];
  locks: LockRow[];
  pendingCommands: CommandRow[];
  trustedAgents: string[];
  pendingResearch: ResearchRow[];
  pausedAgents: string[];
  roles: RoleRow[];
  chats: ChatRow[];
  activeChatId: number;
  meeting: MeetingState | null;
  meetingProposal: MeetingProposal | null;
  lastId: number;
  now: number;
}

export interface DiffRow {
  id: number;
  ts: number;
  agent: string;
  file: string;
  added: number;
  removed: number;
  patch: string;
}

export type DiffInfo = Omit<DiffRow, 'patch'>;
