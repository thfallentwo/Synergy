export type EventType = 'status' | 'lock' | 'unlock' | 'ask' | 'human' | 'system';

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
}

export type AgentStatus = 'working' | 'idle' | 'offline';

export interface AgentView extends AgentRow {
  status: AgentStatus;
}

export interface StateSnapshot {
  agents: AgentView[];
  locks: LockRow[];
  lastId: number;
  now: number;
}
