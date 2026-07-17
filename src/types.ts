export type AgentType =
  | "codex"
  | "claude-code"
  | "gemini-cli"
  | "cursor"
  | "cline"
  | "other";

export type EventType =
  | "agent_joined"
  | "agent_heartbeat"
  | "task_claimed"
  | "scope_claimed"
  | "handoff_created"
  | "terminal_read"
  | "terminal_send"
  | "terminal_named"
  | "attempt"
  | "result"
  | "issue"
  | "discovery"
  | "test"
  | "note"
  | "file_changed"
  | "task_completed";

export interface GitSnapshot {
  available: boolean;
  repositoryRoot: string | null;
  branch: string;
  head: string | null;
  status: string[];
  changedFiles: string[];
  diffStat: string;
  recentCommit: string | null;
  reason: string | null;
}

export interface ProjectRecord {
  id: string;
  name: string;
  rootPath: string;
  createdAt: string;
}

export interface SessionRecord {
  id: string;
  projectId: string;
  agentId: string;
  agentType: AgentType;
  workingPath: string;
  branch: string;
  taskSummary: string | null;
  status: "active" | "ended";
  startedAt: string;
  lastSeenAt: string;
  endedAt: string | null;
}

export interface TaskRecord {
  id: string;
  title: string;
  description: string | null;
  status: "open" | "active" | "blocked" | "completed";
  ownerSessionId: string | null;
  leaseExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScopeClaimRecord {
  id: string;
  sessionId: string;
  taskId: string | null;
  pattern: string;
  leaseExpiresAt: string;
  createdAt: string;
}

export interface SearchResult {
  kind: "event" | "decision" | "handoff";
  sourceId: string;
  title: string;
  body: string;
  createdAt: string;
  rank: number;
}
