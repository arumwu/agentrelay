import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { minimatch } from "minimatch";
import { openDatabase } from "./db.js";
import { captureGitSnapshot, resolveRepositoryRoot } from "./git.js";
import {
  assertSafeRelativePattern,
  filterSafePaths,
  isSensitivePath,
  redactSecrets,
  redactStructured,
} from "./security.js";
import type {
  AgentType,
  EventType,
  ProjectRecord,
  ScopeClaimRecord,
  SearchResult,
  SessionRecord,
  TaskRecord,
} from "./types.js";

interface ProjectRow {
  id: string;
  name: string;
  root_path: string;
  created_at: string;
}

interface SessionRow {
  id: string;
  project_id: string;
  agent_id: string;
  agent_type: AgentType;
  branch: string;
  task_summary: string | null;
  status: "active" | "ended";
  started_at: string;
  last_seen_at: string;
  ended_at: string | null;
}

interface TaskRow {
  id: string;
  title: string;
  description: string | null;
  status: "open" | "active" | "blocked" | "completed";
  owner_session_id: string | null;
  lease_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ScopeRow {
  id: string;
  session_id: string;
  task_id: string | null;
  pattern: string;
  lease_expires_at: string;
  created_at: string;
}

interface EventRow {
  id: string;
  event_type: string;
  summary: string;
  content: string;
  files_json: string;
  evidence_json: string;
  created_at: string;
  session_id: string | null;
  task_id: string | null;
}

interface DecisionRow {
  id: string;
  title: string;
  decision: string;
  reasons_json: string;
  alternatives_json: string;
  scope_json: string;
  status: string;
  created_at: string;
  session_id: string | null;
  task_id: string | null;
}

function now(): string {
  return new Date().toISOString();
}

function leaseUntil(minutes: number): string {
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 240) {
    throw new Error("Lease duration must be an integer from 1 to 240 minutes.");
  }
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

const VALID_AGENT_TYPES = new Set<AgentType>([
  "codex",
  "claude-code",
  "gemini-cli",
  "cursor",
  "cline",
  "other",
]);

const VALID_EVENT_TYPES = new Set<EventType>([
  "agent_joined",
  "agent_heartbeat",
  "task_claimed",
  "scope_claimed",
  "handoff_created",
  "attempt",
  "result",
  "issue",
  "discovery",
  "test",
  "note",
  "file_changed",
  "task_completed",
]);

function mapProject(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    name: row.name,
    rootPath: row.root_path,
    createdAt: row.created_at,
  };
}

function mapSession(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    agentId: row.agent_id,
    agentType: row.agent_type,
    branch: row.branch,
    taskSummary: row.task_summary,
    status: row.status,
    startedAt: row.started_at,
    lastSeenAt: row.last_seen_at,
    endedAt: row.ended_at,
  };
}

function mapTask(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    ownerSessionId: row.owner_session_id,
    leaseExpiresAt: row.lease_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapScope(row: ScopeRow): ScopeClaimRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    taskId: row.task_id,
    pattern: row.pattern,
    leaseExpiresAt: row.lease_expires_at,
    createdAt: row.created_at,
  };
}

function staticGlobPrefix(pattern: string): string {
  const wildcardIndex = pattern.search(/[?*{[(]/);
  return (wildcardIndex === -1 ? pattern : pattern.slice(0, wildcardIndex)).replace(/\/$/, "");
}

export function scopePatternsMayOverlap(left: string, right: string): boolean {
  if (left === right) return true;
  const leftHasGlob = /[?*{[(]/.test(left);
  const rightHasGlob = /[?*{[(]/.test(right);
  if (!leftHasGlob && minimatch(left, right, { dot: true })) return true;
  if (!rightHasGlob && minimatch(right, left, { dot: true })) return true;
  const leftPrefix = staticGlobPrefix(left);
  const rightPrefix = staticGlobPrefix(right);
  if (!leftPrefix || !rightPrefix) return true;
  return (
    leftPrefix === rightPrefix ||
    leftPrefix.startsWith(`${rightPrefix}/`) ||
    rightPrefix.startsWith(`${leftPrefix}/`)
  );
}

function titleSimilarity(left: string, right: string): number {
  const tokenize = (value: string) =>
    new Set(value.toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) ?? []);
  const a = tokenize(left);
  const b = tokenize(right);
  if (a.size === 0 || b.size === 0) return 0;
  const intersection = [...a].filter((token) => b.has(token)).length;
  return intersection / Math.min(a.size, b.size);
}

function ftsQuery(input: string): string {
  const tokens = input.match(/[\p{L}\p{N}_./:-]+/gu) ?? [];
  if (tokens.length === 0) throw new Error("Search query must include letters or numbers.");
  return tokens.slice(0, 12).map((token) => `"${token.replaceAll('"', '""')}"`).join(" OR ");
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 24))}\n…[context truncated]`;
}

export class ProjectStore {
  readonly rootPath: string;
  readonly dataDir: string;
  readonly dbPath: string;
  readonly project: ProjectRecord;
  private readonly db: Database.Database;

  constructor(inputPath: string, projectName?: string) {
    this.rootPath = resolveRepositoryRoot(inputPath);
    const handle = openDatabase(this.rootPath);
    this.db = handle.db;
    this.dataDir = handle.dataDir;
    this.dbPath = handle.dbPath;
    this.project = this.ensureProject(projectName);
  }

  private ensureProject(projectName?: string): ProjectRecord {
    const existing = this.db
      .prepare("SELECT id, name, root_path, created_at FROM projects WHERE root_path = ?")
      .get(this.rootPath) as ProjectRow | undefined;
    if (existing) return mapProject(existing);

    const timestamp = now();
    const record: ProjectRow = {
      id: randomUUID(),
      name: redactSecrets(projectName?.trim() || path.basename(this.rootPath)),
      root_path: this.rootPath,
      created_at: timestamp,
    };
    this.db
      .prepare(
        "INSERT INTO projects (id, name, root_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(record.id, record.name, record.root_path, timestamp, timestamp);
    return mapProject(record);
  }

  private requireSession(sessionId: string): SessionRecord {
    const row = this.db
      .prepare(
        "SELECT id, project_id, agent_id, agent_type, branch, task_summary, status, started_at, last_seen_at, ended_at FROM sessions WHERE id = ? AND project_id = ?",
      )
      .get(sessionId, this.project.id) as SessionRow | undefined;
    if (!row) throw new Error(`Unknown agent session: ${sessionId}`);
    return mapSession(row);
  }

  private requireActiveSession(sessionId: string): SessionRecord {
    const session = this.requireSession(sessionId);
    if (session.status !== "active") throw new Error(`Agent session has ended: ${sessionId}`);
    return session;
  }

  private requireTask(taskId: string): TaskRecord {
    const row = this.db
      .prepare(
        "SELECT id, title, description, status, owner_session_id, lease_expires_at, created_at, updated_at FROM tasks WHERE id = ? AND project_id = ?",
      )
      .get(taskId, this.project.id) as TaskRow | undefined;
    if (!row) throw new Error(`Unknown task: ${taskId}`);
    return mapTask(row);
  }

  private appendSearchDocument(
    kind: SearchResult["kind"],
    sourceId: string,
    title: string,
    body: string,
    createdAt: string,
  ): void {
    this.db
      .prepare(
        "INSERT INTO search_documents (id, project_id, kind, source_id, title, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(randomUUID(), this.project.id, kind, sourceId, title, body, createdAt);
  }

  private appendJsonl(payload: Record<string, unknown>): void {
    fs.appendFileSync(
      path.join(this.dataDir, "events.jsonl"),
      `${JSON.stringify(payload)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  }

  initSummary(): Record<string, unknown> {
    const snapshot = captureGitSnapshot(this.rootPath);
    return {
      project: this.project,
      database: this.dbPath,
      git: snapshot,
      security: {
        repositoryBoundary: this.rootPath,
        arbitraryShellCommands: false,
        secretRedaction: true,
      },
    };
  }

  joinAgent(input: {
    agentId: string;
    agentType: AgentType;
    taskSummary?: string;
    metadata?: Record<string, unknown>;
  }): SessionRecord {
    if (!input.agentId.trim()) throw new Error("agentId cannot be empty.");
    if (!VALID_AGENT_TYPES.has(input.agentType)) throw new Error(`Unsupported agent type: ${input.agentType}`);
    const timestamp = now();
    const sessionId = randomUUID();
    const branch = captureGitSnapshot(this.rootPath).branch;
    const taskSummary = input.taskSummary ? redactSecrets(input.taskSummary) : null;
    this.db
      .prepare(
        `INSERT INTO sessions
         (id, project_id, agent_id, agent_type, branch, task_summary, status, metadata_json, started_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      )
      .run(
        sessionId,
        this.project.id,
        redactSecrets(input.agentId.trim()),
        input.agentType,
        branch,
        taskSummary,
        JSON.stringify(redactStructured(input.metadata ?? {})),
        timestamp,
        timestamp,
      );
    this.recordEvent({
      sessionId,
      eventType: "agent_joined",
      summary: `${input.agentId} joined on ${branch}`,
      content: taskSummary ?? "Agent joined without a task summary.",
    });
    return this.requireSession(sessionId);
  }

  heartbeat(sessionId: string, leaseMinutes = 30): Record<string, unknown> {
    this.requireActiveSession(sessionId);
    const timestamp = now();
    const expiry = leaseUntil(leaseMinutes);
    const transaction = this.db.transaction(() => {
      this.db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").run(timestamp, sessionId);
      const tasks = this.db
        .prepare(
          "UPDATE tasks SET lease_expires_at = ?, updated_at = ? WHERE owner_session_id = ? AND status = 'active'",
        )
        .run(expiry, timestamp, sessionId).changes;
      const scopes = this.db
        .prepare(
          "UPDATE scope_claims SET lease_expires_at = ?, updated_at = ? WHERE session_id = ? AND lease_expires_at > ?",
        )
        .run(expiry, timestamp, sessionId, timestamp).changes;
      return { tasks, scopes };
    });
    const renewed = transaction();
    return { session: this.requireSession(sessionId), renewed, leaseExpiresAt: expiry };
  }

  projectStatus(): Record<string, unknown> {
    const timestamp = now();
    const sessions = this.db
      .prepare(
        "SELECT id, project_id, agent_id, agent_type, branch, task_summary, status, started_at, last_seen_at, ended_at FROM sessions WHERE project_id = ? AND status = 'active' ORDER BY last_seen_at DESC",
      )
      .all(this.project.id) as SessionRow[];
    const tasks = this.db
      .prepare(
        "SELECT id, title, description, status, owner_session_id, lease_expires_at, created_at, updated_at FROM tasks WHERE project_id = ? AND status != 'completed' ORDER BY updated_at DESC",
      )
      .all(this.project.id) as TaskRow[];
    const scopes = this.db
      .prepare(
        "SELECT id, session_id, task_id, pattern, lease_expires_at, created_at FROM scope_claims WHERE project_id = ? AND lease_expires_at > ? ORDER BY created_at DESC",
      )
      .all(this.project.id, timestamp) as ScopeRow[];
    return {
      project: this.project,
      git: captureGitSnapshot(this.rootPath),
      activeSessions: sessions.map(mapSession),
      openTasks: tasks.map(mapTask),
      activeScopeClaims: scopes.map(mapScope),
    };
  }

  claimTask(input: {
    sessionId: string;
    taskId?: string;
    title?: string;
    description?: string;
    leaseMinutes?: number;
  }): Record<string, unknown> {
    this.requireActiveSession(input.sessionId);
    const timestamp = now();
    const expiry = leaseUntil(input.leaseMinutes ?? 30);
    let task: TaskRecord;
    if (input.taskId) {
      task = this.requireTask(input.taskId);
    } else {
      if (!input.title?.trim()) throw new Error("title is required when taskId is omitted.");
      const taskId = randomUUID();
      this.db
        .prepare(
          `INSERT INTO tasks
           (id, project_id, title, description, status, owner_session_id, lease_expires_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'open', NULL, NULL, ?, ?)`,
        )
        .run(
          taskId,
          this.project.id,
          redactSecrets(input.title.trim()),
          input.description ? redactSecrets(input.description) : null,
          timestamp,
          timestamp,
        );
      task = this.requireTask(taskId);
    }

    if (task.status === "completed") throw new Error(`Task is already completed: ${task.id}`);
    const activeForeignLease =
      task.ownerSessionId &&
      task.ownerSessionId !== input.sessionId &&
      task.leaseExpiresAt &&
      task.leaseExpiresAt > timestamp;
    if (activeForeignLease) {
      return {
        claimed: false,
        conflict: {
          type: "task_conflict",
          ownerSessionId: task.ownerSessionId,
          leaseExpiresAt: task.leaseExpiresAt,
          task,
        },
      };
    }

    this.db
      .prepare(
        "UPDATE tasks SET status = 'active', owner_session_id = ?, lease_expires_at = ?, updated_at = ? WHERE id = ?",
      )
      .run(input.sessionId, expiry, timestamp, task.id);
    this.recordEvent({
      sessionId: input.sessionId,
      taskId: task.id,
      eventType: "task_claimed",
      summary: `Claimed task: ${task.title}`,
      content: `Lease expires at ${expiry}.`,
    });
    return { claimed: true, task: this.requireTask(task.id) };
  }

  claimScope(input: {
    sessionId: string;
    patterns: string[];
    taskId?: string;
    leaseMinutes?: number;
  }): Record<string, unknown> {
    this.requireActiveSession(input.sessionId);
    if (input.taskId) this.requireTask(input.taskId);
    const patterns = [...new Set(input.patterns.map(assertSafeRelativePattern))];
    if (patterns.length === 0) throw new Error("At least one scope pattern is required.");
    const timestamp = now();
    const expiry = leaseUntil(input.leaseMinutes ?? 30);
    const existing = this.db
      .prepare(
        "SELECT id, session_id, task_id, pattern, lease_expires_at, created_at FROM scope_claims WHERE project_id = ? AND lease_expires_at > ? AND session_id != ?",
      )
      .all(this.project.id, timestamp, input.sessionId) as ScopeRow[];
    const conflicts = patterns.flatMap((pattern) =>
      existing
        .filter((claim) => scopePatternsMayOverlap(pattern, claim.pattern))
        .map((claim) => ({ requestedPattern: pattern, existingClaim: mapScope(claim) })),
    );

    const insert = this.db.prepare(
      `INSERT INTO scope_claims
       (id, project_id, session_id, task_id, pattern, lease_expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const claimed = this.db.transaction(() =>
      patterns.map((pattern) => {
        const id = randomUUID();
        insert.run(
          id,
          this.project.id,
          input.sessionId,
          input.taskId ?? null,
          pattern,
          expiry,
          timestamp,
          timestamp,
        );
        return mapScope({
          id,
          session_id: input.sessionId,
          task_id: input.taskId ?? null,
          pattern,
          lease_expires_at: expiry,
          created_at: timestamp,
        });
      }),
    )();
    this.recordEvent({
      sessionId: input.sessionId,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      eventType: "scope_claimed",
      summary: `Claimed ${patterns.length} scope pattern(s)`,
      content: patterns.join("\n"),
      files: patterns,
      metadata: { conflictCount: conflicts.length },
    });
    return {
      claimed,
      advisoryConflicts: conflicts,
      note: conflicts.length > 0 ? "Scope claims are advisory; coordinate before editing overlaps." : null,
    };
  }

  recordEvent(input: {
    sessionId?: string;
    taskId?: string;
    eventType: EventType;
    summary: string;
    content: string;
    files?: string[];
    evidence?: string[];
    metadata?: Record<string, unknown>;
  }): Record<string, unknown> {
    if (!VALID_EVENT_TYPES.has(input.eventType)) {
      throw new Error(`Unsupported event type: ${input.eventType}`);
    }
    if (input.eventType === "task_completed" && !input.taskId) {
      throw new Error("task_completed events require a taskId.");
    }
    if (input.sessionId) this.requireSession(input.sessionId);
    if (input.taskId) this.requireTask(input.taskId);
    const id = randomUUID();
    const timestamp = now();
    const summary = redactSecrets(input.summary.trim());
    const content = redactSecrets(input.content.trim());
    if (!summary || !content) throw new Error("Event summary and content cannot be empty.");
    const files = filterSafePaths(
      (input.files ?? [])
        .filter((filePath) => !isSensitivePath(filePath))
        .map(assertSafeRelativePattern),
    );
    const evidence = (input.evidence ?? []).map(redactSecrets);
    const metadata = redactStructured(input.metadata ?? {}) as Record<string, unknown>;
    const transaction = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO events
           (id, project_id, session_id, task_id, event_type, summary, content, files_json, evidence_json, metadata_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          this.project.id,
          input.sessionId ?? null,
          input.taskId ?? null,
          input.eventType,
          summary,
          content,
          JSON.stringify(files),
          JSON.stringify(evidence),
          JSON.stringify(metadata),
          timestamp,
        );
      this.appendSearchDocument("event", id, summary, `${input.eventType}\n${content}`, timestamp);
      if (input.sessionId) {
        this.db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").run(timestamp, input.sessionId);
      }
      if (input.eventType === "task_completed" && input.taskId) {
        this.db
          .prepare(
            "UPDATE tasks SET status = 'completed', owner_session_id = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?",
          )
          .run(timestamp, input.taskId);
      }
    });
    transaction();
    this.appendJsonl({
      id,
      projectId: this.project.id,
      sessionId: input.sessionId ?? null,
      taskId: input.taskId ?? null,
      eventType: input.eventType,
      summary,
      content,
      files,
      evidence,
      metadata,
      createdAt: timestamp,
    });
    return { id, eventType: input.eventType, summary, content, files, evidence, createdAt: timestamp };
  }

  recordDecision(input: {
    sessionId?: string;
    taskId?: string;
    title: string;
    decision: string;
    reasons?: string[];
    alternatives?: string[];
    scope?: string[];
    supersedesId?: string;
  }): Record<string, unknown> {
    if (input.sessionId) this.requireSession(input.sessionId);
    if (input.taskId) this.requireTask(input.taskId);
    const id = randomUUID();
    const timestamp = now();
    const title = redactSecrets(input.title.trim());
    const decision = redactSecrets(input.decision.trim());
    if (!title || !decision) throw new Error("Decision title and content cannot be empty.");
    const reasons = (input.reasons ?? []).map(redactSecrets);
    const alternatives = (input.alternatives ?? []).map(redactSecrets);
    const scope = [...new Set((input.scope ?? []).map(assertSafeRelativePattern))];
    const active = this.db
      .prepare(
        "SELECT id, title, decision, reasons_json, alternatives_json, scope_json, status, created_at, session_id, task_id FROM decisions WHERE project_id = ? AND status = 'active' ORDER BY created_at DESC",
      )
      .all(this.project.id) as DecisionRow[];
    const potentialConflicts = active
      .filter((row) => row.id !== input.supersedesId)
      .filter((row) => {
        const priorScope = JSON.parse(row.scope_json) as string[];
        const scopeOverlap =
          scope.length > 0 && priorScope.some((a) => scope.some((b) => scopePatternsMayOverlap(a, b)));
        const relatedTitle = titleSimilarity(title, row.title) >= 0.5;
        return (scopeOverlap || relatedTitle || row.task_id === input.taskId) && row.decision !== decision;
      })
      .slice(0, 10)
      .map((row) => ({ id: row.id, title: row.title, decision: row.decision }));

    const transaction = this.db.transaction(() => {
      if (input.supersedesId) {
        const result = this.db
          .prepare(
            "UPDATE decisions SET status = 'superseded', updated_at = ? WHERE id = ? AND project_id = ? AND status = 'active'",
          )
          .run(timestamp, input.supersedesId, this.project.id);
        if (result.changes === 0) throw new Error(`Active decision to supersede was not found: ${input.supersedesId}`);
      }
      this.db
        .prepare(
          `INSERT INTO decisions
           (id, project_id, session_id, task_id, title, decision, reasons_json, alternatives_json, scope_json, status, supersedes_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
        )
        .run(
          id,
          this.project.id,
          input.sessionId ?? null,
          input.taskId ?? null,
          title,
          decision,
          JSON.stringify(reasons),
          JSON.stringify(alternatives),
          JSON.stringify(scope),
          input.supersedesId ?? null,
          timestamp,
          timestamp,
        );
      this.appendSearchDocument(
        "decision",
        id,
        title,
        [decision, ...reasons, ...alternatives, ...scope].join("\n"),
        timestamp,
      );
    });
    transaction();
    this.appendJsonl({
      id,
      type: "decision_recorded",
      projectId: this.project.id,
      sessionId: input.sessionId ?? null,
      taskId: input.taskId ?? null,
      title,
      decision,
      reasons,
      alternatives,
      scope,
      supersedesId: input.supersedesId ?? null,
      createdAt: timestamp,
    });
    return { id, title, decision, reasons, alternatives, scope, potentialConflicts, createdAt: timestamp };
  }

  searchMemory(query: string, limit = 10, kinds?: SearchResult["kind"][]): SearchResult[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new Error("Search limit must be an integer from 1 to 50.");
    }
    const kindFilter = kinds && kinds.length > 0;
    const placeholders = kindFilter ? kinds.map(() => "?").join(", ") : "";
    const sql = `
      SELECT d.kind, d.source_id, d.title, d.body, d.created_at, bm25(search_documents_fts) AS rank
      FROM search_documents_fts
      JOIN search_documents d ON d.rowid = search_documents_fts.rowid
      WHERE search_documents_fts MATCH ? AND d.project_id = ?
      ${kindFilter ? `AND d.kind IN (${placeholders})` : ""}
      ORDER BY rank, d.created_at DESC
      LIMIT ?`;
    const params: unknown[] = [ftsQuery(query), this.project.id];
    if (kindFilter) params.push(...kinds);
    params.push(limit);
    const rows = this.db.prepare(sql).all(...params) as Array<{
      kind: SearchResult["kind"];
      source_id: string;
      title: string;
      body: string;
      created_at: string;
      rank: number;
    }>;
    return rows.map((row) => ({
      kind: row.kind,
      sourceId: row.source_id,
      title: row.title,
      body: row.body,
      createdAt: row.created_at,
      rank: row.rank,
    }));
  }

  buildContext(input: { task: string; tokenBudget?: number }): Record<string, unknown> {
    if (!input.task.trim()) throw new Error("Context task cannot be empty.");
    const tokenBudget = input.tokenBudget ?? 5000;
    if (!Number.isInteger(tokenBudget) || tokenBudget < 500 || tokenBudget > 20_000) {
      throw new Error("Context token budget must be an integer from 500 to 20000.");
    }
    const charBudget = tokenBudget * 4;
    const status = this.projectStatus() as {
      git: unknown;
      activeSessions: SessionRecord[];
      openTasks: TaskRecord[];
      activeScopeClaims: ScopeClaimRecord[];
    };
    const related = this.searchMemory(input.task, 20);
    const activeDecisions = this.db
      .prepare(
        "SELECT id, title, decision, reasons_json, alternatives_json, scope_json, status, created_at, session_id, task_id FROM decisions WHERE project_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 20",
      )
      .all(this.project.id) as DecisionRow[];
    const failedAttempts = this.db
      .prepare(
        "SELECT id, event_type, summary, content, files_json, evidence_json, created_at, session_id, task_id FROM events WHERE project_id = ? AND event_type = 'attempt' ORDER BY created_at DESC LIMIT 20",
      )
      .all(this.project.id) as EventRow[];

    const sections = [
      `# DevRelay Context Pack\n\nTask: ${redactSecrets(input.task)}\nProject: ${this.project.name}\nRepository: ${this.rootPath}`,
      `## Git snapshot\n\n${JSON.stringify(status.git, null, 2)}`,
      `## Active agents\n\n${JSON.stringify(status.activeSessions, null, 2)}`,
      `## Open tasks and leases\n\n${JSON.stringify(status.openTasks, null, 2)}`,
      `## Active scope claims\n\n${JSON.stringify(status.activeScopeClaims, null, 2)}`,
      `## Related memory\n\n${related
        .map((item) => `### ${item.kind}: ${item.title}\n${truncate(item.body, 1200)}`)
        .join("\n\n") || "None found."}`,
      `## Active decisions\n\n${activeDecisions
        .map((item) => `- ${item.title}: ${item.decision} (scope: ${item.scope_json})`)
        .join("\n") || "None recorded."}`,
      `## Prior attempts\n\n${failedAttempts
        .map((item) => `- ${item.summary}: ${truncate(item.content, 700)}`)
        .join("\n") || "None recorded."}`,
    ];
    const context = truncate(sections.join("\n\n"), charBudget);
    return {
      task: redactSecrets(input.task),
      tokenBudget,
      estimatedTokens: Math.ceil(context.length / 4),
      context,
    };
  }

  createHandoff(input: {
    sessionId: string;
    taskId?: string;
    title?: string;
    notes?: string;
    endSession?: boolean;
  }): Record<string, unknown> {
    const session = this.requireActiveSession(input.sessionId);
    if (input.taskId) this.requireTask(input.taskId);
    const snapshot = captureGitSnapshot(this.rootPath);
    const timestamp = now();
    const id = randomUUID();
    const events = this.db
      .prepare(
        `SELECT id, event_type, summary, content, files_json, evidence_json, created_at, session_id, task_id
         FROM events WHERE project_id = ? AND session_id = ?
         ${input.taskId ? "AND task_id = ?" : ""}
         ORDER BY created_at DESC LIMIT 30`,
      )
      .all(...(input.taskId ? [this.project.id, input.sessionId, input.taskId] : [this.project.id, input.sessionId])) as EventRow[];
    const decisions = this.db
      .prepare(
        `SELECT id, title, decision, reasons_json, alternatives_json, scope_json, status, created_at, session_id, task_id
         FROM decisions WHERE project_id = ? AND session_id = ?
         ${input.taskId ? "AND task_id = ?" : ""}
         ORDER BY created_at DESC LIMIT 20`,
      )
      .all(...(input.taskId ? [this.project.id, input.sessionId, input.taskId] : [this.project.id, input.sessionId])) as DecisionRow[];
    const ownedTasks = this.db
      .prepare(
        `SELECT id, title, description, status, owner_session_id, lease_expires_at, created_at, updated_at
         FROM tasks WHERE project_id = ? AND ${input.taskId ? "id = ?" : "owner_session_id = ?"}
         ORDER BY updated_at DESC`,
      )
      .all(this.project.id, input.taskId ?? input.sessionId) as TaskRow[];
    const completed = events.filter((event) => ["result", "task_completed"].includes(event.event_type));
    const tests = events.filter((event) => event.event_type === "test");
    const attempts = events.filter((event) => event.event_type === "attempt");
    const issues = events.filter((event) => event.event_type === "issue");
    const title = redactSecrets(input.title?.trim() || `Handoff from ${session.agentId}`);
    const renderEvents = (items: EventRow[], empty: string) =>
      items.map((item) => `- ${item.summary}: ${item.content}`).join("\n") || empty;
    const body = `# ${title}

Created: ${timestamp}
Agent: ${session.agentId} (${session.agentType})
Branch: ${snapshot.branch}
Commit: ${snapshot.head ?? "No commit yet"}

## Work completed

${renderEvents(completed, "No completed-result events were recorded.")}

## Current tasks

${ownedTasks.map((task) => `- [${task.status}] ${task.title}`).join("\n") || "No owned tasks."}

## Files changed

${snapshot.changedFiles.map((file) => `- ${file}`).join("\n") || "No safe changed files detected."}

## Git diff summary

${snapshot.diffStat || "No tracked diff."}

## Tests

${renderEvents(tests, "No test events were recorded.")}

## Decisions

${decisions.map((item) => `- ${item.title}: ${item.decision}`).join("\n") || "No decisions recorded."}

## Failed attempts — do not repeat without new evidence

${renderEvents(attempts, "No failed attempts recorded.")}

## Known issues and blockers

${renderEvents(issues, "No issues recorded.")}

## Agent notes

${redactSecrets(input.notes?.trim() || "No additional notes.")}

## Suggested continuation

Read this handoff, call build_context for the next task, then claim the task and affected scope before editing.
`;
    const safeTimestamp = timestamp.replaceAll(":", "-");
    const filePath = path.join(this.dataDir, "handoffs", `${safeTimestamp}-${id.slice(0, 8)}.md`);
    fs.writeFileSync(filePath, body, { encoding: "utf8", mode: 0o600 });
    const transaction = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO handoffs
           (id, project_id, from_session_id, task_id, title, body, git_head, git_branch, changed_files_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          this.project.id,
          input.sessionId,
          input.taskId ?? null,
          title,
          body,
          snapshot.head,
          snapshot.branch,
          JSON.stringify(snapshot.changedFiles),
          timestamp,
        );
      this.appendSearchDocument("handoff", id, title, body, timestamp);
      if (input.endSession ?? true) {
        this.db
          .prepare("UPDATE sessions SET status = 'ended', ended_at = ?, last_seen_at = ? WHERE id = ?")
          .run(timestamp, timestamp, input.sessionId);
        this.db
          .prepare(
            "UPDATE tasks SET status = CASE WHEN status = 'active' THEN 'open' ELSE status END, owner_session_id = NULL, lease_expires_at = NULL, updated_at = ? WHERE owner_session_id = ?",
          )
          .run(timestamp, input.sessionId);
        this.db.prepare("DELETE FROM scope_claims WHERE session_id = ?").run(input.sessionId);
      }
    });
    transaction();
    this.recordEvent({
      sessionId: input.sessionId,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      eventType: "handoff_created",
      summary: title,
      content: `Handoff written to ${path.relative(this.rootPath, filePath)}.`,
      files: snapshot.changedFiles,
    });
    return { id, title, body, filePath, git: snapshot, sessionEnded: input.endSession ?? true };
  }

  close(): void {
    this.db.close();
  }
}
