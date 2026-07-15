import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { ProjectStore } from "./store.js";
import type { AgentType, EventType, SearchResult } from "./types.js";

const agentTypes = ["codex", "claude-code", "gemini-cli", "cursor", "cline", "other"] as const;
const eventTypes = [
  "attempt",
  "result",
  "issue",
  "discovery",
  "test",
  "note",
  "file_changed",
  "task_completed",
] as const;
const searchKinds = ["event", "decision", "handoff"] as const;

function response(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

function registerTools(server: McpServer, store: ProjectStore): void {
  server.registerTool(
    "project_init",
    {
      title: "Initialize or inspect AgentRelay",
      description: "Initialize workspace-local AgentRelay storage and return the fixed filesystem boundary.",
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async () => response(store.initSummary()),
  );

  server.registerTool(
    "agent_join",
    {
      title: "Join an agent session",
      description: "Register a coding agent session and its current directory inside this workspace.",
      inputSchema: {
        agent_id: z.string().min(1).max(120),
        agent_type: z.enum(agentTypes),
        working_directory: z.string().min(1).max(2_000).optional(),
        task_summary: z.string().max(2_000).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ agent_id, agent_type, working_directory, task_summary, metadata }) => {
      try {
        return response(
          store.joinAgent({
            agentId: agent_id,
            agentType: agent_type as AgentType,
            ...(working_directory ? { workingDirectory: working_directory } : {}),
            ...(task_summary ? { taskSummary: task_summary } : {}),
            ...(metadata ? { metadata } : {}),
          }),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "agent_status",
    {
      title: "Get project coordination status",
      description: "List active agents, task leases, scope claims, and Git state; optionally heartbeat a session.",
      inputSchema: {
        session_id: z.string().uuid().optional(),
        renew_lease_minutes: z.number().int().min(1).max(240).default(30),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ session_id, renew_lease_minutes }) => {
      try {
        const heartbeat = session_id
          ? store.heartbeat(session_id, renew_lease_minutes)
          : null;
        return response({ heartbeat, status: store.projectStatus() });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "claim_task",
    {
      title: "Claim a task lease",
      description: "Create or claim a task with an expiring lease. Active foreign leases return a conflict.",
      inputSchema: {
        session_id: z.string().uuid(),
        task_id: z.string().uuid().optional(),
        title: z.string().min(1).max(300).optional(),
        description: z.string().max(4_000).optional(),
        lease_minutes: z.number().int().min(1).max(240).default(30),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ session_id, task_id, title, description, lease_minutes }) => {
      try {
        return response(
          store.claimTask({
            sessionId: session_id,
            ...(task_id ? { taskId: task_id } : {}),
            ...(title ? { title } : {}),
            ...(description ? { description } : {}),
            leaseMinutes: lease_minutes,
          }),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "claim_scope",
    {
      title: "Claim files or modules",
      description: "Register advisory workspace-relative file or glob claims and report overlaps.",
      inputSchema: {
        session_id: z.string().uuid(),
        patterns: z.array(z.string().min(1).max(500)).min(1).max(50),
        task_id: z.string().uuid().optional(),
        lease_minutes: z.number().int().min(1).max(240).default(30),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ session_id, patterns, task_id, lease_minutes }) => {
      try {
        return response(
          store.claimScope({
            sessionId: session_id,
            patterns,
            ...(task_id ? { taskId: task_id } : {}),
            leaseMinutes: lease_minutes,
          }),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "record_event",
    {
      title: "Record a development event",
      description: "Record an attempt, result, issue, discovery, test, note, file change, or completion event.",
      inputSchema: {
        session_id: z.string().uuid().optional(),
        task_id: z.string().uuid().optional(),
        event_type: z.enum(eventTypes),
        summary: z.string().min(1).max(500),
        content: z.string().min(1).max(20_000),
        files: z.array(z.string().max(500)).max(200).optional(),
        evidence: z.array(z.string().max(2_000)).max(100).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ session_id, task_id, event_type, summary, content, files, evidence, metadata }) => {
      try {
        return response(
          store.recordEvent({
            ...(session_id ? { sessionId: session_id } : {}),
            ...(task_id ? { taskId: task_id } : {}),
            eventType: event_type as EventType,
            summary,
            content,
            ...(files ? { files } : {}),
            ...(evidence ? { evidence } : {}),
            ...(metadata ? { metadata } : {}),
          }),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "record_decision",
    {
      title: "Record an architecture decision",
      description: "Record a structured decision and flag related active decisions as potential conflicts.",
      inputSchema: {
        session_id: z.string().uuid().optional(),
        task_id: z.string().uuid().optional(),
        title: z.string().min(1).max(500),
        decision: z.string().min(1).max(10_000),
        reasons: z.array(z.string().max(2_000)).max(50).optional(),
        alternatives: z.array(z.string().max(2_000)).max(50).optional(),
        scope: z.array(z.string().max(500)).max(100).optional(),
        supersedes_id: z.string().uuid().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ session_id, task_id, title, decision, reasons, alternatives, scope, supersedes_id }) => {
      try {
        return response(
          store.recordDecision({
            ...(session_id ? { sessionId: session_id } : {}),
            ...(task_id ? { taskId: task_id } : {}),
            title,
            decision,
            ...(reasons ? { reasons } : {}),
            ...(alternatives ? { alternatives } : {}),
            ...(scope ? { scope } : {}),
            ...(supersedes_id ? { supersedesId: supersedes_id } : {}),
          }),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "search_memory",
    {
      title: "Search shared project memory",
      description: "Search events, decisions, and handoffs using local SQLite FTS5.",
      inputSchema: {
        query: z.string().min(1).max(1_000),
        limit: z.number().int().min(1).max(50).default(10),
        kinds: z.array(z.enum(searchKinds)).max(3).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ query, limit, kinds }) => {
      try {
        return response(
          store.searchMemory(
            query,
            limit,
            kinds as SearchResult["kind"][] | undefined,
          ),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "build_context",
    {
      title: "Compile a task-specific context pack",
      description: "Compile Git state, agents, leases, decisions, attempts, and related memory within a token budget.",
      inputSchema: {
        task: z.string().min(1).max(2_000),
        token_budget: z.number().int().min(500).max(20_000).default(5_000),
        working_directory: z.string().min(1).max(2_000).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ task, token_budget, working_directory }) => {
      try {
        return response(store.buildContext({
          task,
          tokenBudget: token_budget,
          ...(working_directory ? { workingDirectory: working_directory } : {}),
        }));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "create_handoff",
    {
      title: "Create a Git-aware handoff",
      description: "Create a deterministic Markdown handoff from Git state and recorded work, then release leases.",
      inputSchema: {
        session_id: z.string().uuid(),
        task_id: z.string().uuid().optional(),
        title: z.string().min(1).max(500).optional(),
        notes: z.string().max(10_000).optional(),
        end_session: z.boolean().default(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ session_id, task_id, title, notes, end_session }) => {
      try {
        return response(
          store.createHandoff({
            sessionId: session_id,
            ...(task_id ? { taskId: task_id } : {}),
            ...(title ? { title } : {}),
            ...(notes ? { notes } : {}),
            endSession: end_session,
          }),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );
}

export function createMcpServer(store: ProjectStore): McpServer {
  const server = new McpServer({ name: "agentrelay", version: "0.3.0" });
  registerTools(server, store);
  return server;
}

export async function serveStdio(store: ProjectStore): Promise<void> {
  const server = createMcpServer(store);
  const transport = new StdioServerTransport();
  const shutdown = async () => {
    await server.close();
    store.close();
  };
  process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
  await server.connect(transport);
}
