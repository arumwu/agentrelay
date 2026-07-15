#!/usr/bin/env node
import { Command, Option } from "commander";
import { serveStdio } from "./mcp.js";
import { ProjectStore } from "./store.js";
import type { AgentType, EventType, SearchResult } from "./types.js";

function print(value: unknown): void {
  process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`);
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function withStore<T>(repo: string, callback: (store: ProjectStore) => T): T {
  const store = new ProjectStore(repo);
  try {
    return callback(store);
  } finally {
    store.close();
  }
}

const program = new Command()
  .name("devrelay")
  .description("Local-first coordination and shared project memory for coding agents.")
  .version("0.1.0")
  .option("-r, --repo <path>", "Git repository to coordinate", process.cwd());

program
  .command("init")
  .description("Initialize .devrelay storage in the repository")
  .option("--name <name>", "Project display name")
  .action((options: { name?: string }) => {
    const repo = program.opts<{ repo: string }>().repo;
    const store = new ProjectStore(repo, options.name);
    try {
      print(store.initSummary());
    } finally {
      store.close();
    }
  });

program
  .command("serve")
  .description("Run the DevRelay MCP server over stdio")
  .action(async () => {
    const repo = program.opts<{ repo: string }>().repo;
    await serveStdio(new ProjectStore(repo));
  });

program
  .command("join")
  .description("Register an agent session")
  .requiredOption("--agent <id>", "Stable agent identifier")
  .addOption(new Option("--type <type>", "Agent type").choices(["codex", "claude-code", "gemini-cli", "cursor", "cline", "other"]).default("other"))
  .option("--task <summary>", "Current task summary")
  .action((options: { agent: string; type: AgentType; task?: string }) => {
    const repo = program.opts<{ repo: string }>().repo;
    print(withStore(repo, (store) => store.joinAgent({
      agentId: options.agent,
      agentType: options.type,
      ...(options.task ? { taskSummary: options.task } : {}),
    })));
  });

program
  .command("status")
  .description("Show agents, tasks, scope claims, and Git state")
  .option("--session <uuid>", "Heartbeat and renew leases for this session")
  .option("--lease <minutes>", "Lease renewal in minutes", "30")
  .action((options: { session?: string; lease: string }) => {
    const repo = program.opts<{ repo: string }>().repo;
    print(withStore(repo, (store) => ({
      heartbeat: options.session ? store.heartbeat(options.session, Number(options.lease)) : null,
      status: store.projectStatus(),
    })));
  });

program
  .command("claim-task")
  .description("Create or claim an expiring task lease")
  .requiredOption("--session <uuid>", "Agent session")
  .option("--task-id <uuid>", "Existing task")
  .option("--title <title>", "New task title")
  .option("--description <description>", "New task description")
  .option("--lease <minutes>", "Lease duration", "30")
  .action((options: { session: string; taskId?: string; title?: string; description?: string; lease: string }) => {
    const repo = program.opts<{ repo: string }>().repo;
    print(withStore(repo, (store) => store.claimTask({
      sessionId: options.session,
      ...(options.taskId ? { taskId: options.taskId } : {}),
      ...(options.title ? { title: options.title } : {}),
      ...(options.description ? { description: options.description } : {}),
      leaseMinutes: Number(options.lease),
    })));
  });

program
  .command("claim-scope")
  .description("Claim advisory file or module scopes")
  .requiredOption("--session <uuid>", "Agent session")
  .requiredOption("--pattern <glob>", "Repository-relative path or glob", collect, [])
  .option("--task-id <uuid>", "Related task")
  .option("--lease <minutes>", "Lease duration", "30")
  .action((options: { session: string; pattern: string[]; taskId?: string; lease: string }) => {
    const repo = program.opts<{ repo: string }>().repo;
    print(withStore(repo, (store) => store.claimScope({
      sessionId: options.session,
      patterns: options.pattern,
      ...(options.taskId ? { taskId: options.taskId } : {}),
      leaseMinutes: Number(options.lease),
    })));
  });

program
  .command("event")
  .description("Record a development event")
  .requiredOption("--type <type>", "attempt, result, issue, discovery, test, note, file_changed, or task_completed")
  .requiredOption("--summary <summary>", "Short summary")
  .requiredOption("--content <content>", "Event details")
  .option("--session <uuid>", "Agent session")
  .option("--task-id <uuid>", "Related task")
  .option("--file <path>", "Related safe repository path", collect, [])
  .option("--evidence <value>", "Evidence reference", collect, [])
  .action((options: { type: EventType; summary: string; content: string; session?: string; taskId?: string; file: string[]; evidence: string[] }) => {
    const repo = program.opts<{ repo: string }>().repo;
    print(withStore(repo, (store) => store.recordEvent({
      ...(options.session ? { sessionId: options.session } : {}),
      ...(options.taskId ? { taskId: options.taskId } : {}),
      eventType: options.type,
      summary: options.summary,
      content: options.content,
      files: options.file,
      evidence: options.evidence,
    })));
  });

program
  .command("decision")
  .description("Record a structured architecture decision")
  .requiredOption("--title <title>", "Decision title")
  .requiredOption("--decision <decision>", "Chosen approach")
  .option("--session <uuid>", "Agent session")
  .option("--task-id <uuid>", "Related task")
  .option("--reason <reason>", "Reason", collect, [])
  .option("--alternative <alternative>", "Alternative considered", collect, [])
  .option("--scope <path>", "Affected path or glob", collect, [])
  .option("--supersedes <uuid>", "Prior decision to supersede")
  .action((options: { title: string; decision: string; session?: string; taskId?: string; reason: string[]; alternative: string[]; scope: string[]; supersedes?: string }) => {
    const repo = program.opts<{ repo: string }>().repo;
    print(withStore(repo, (store) => store.recordDecision({
      ...(options.session ? { sessionId: options.session } : {}),
      ...(options.taskId ? { taskId: options.taskId } : {}),
      title: options.title,
      decision: options.decision,
      reasons: options.reason,
      alternatives: options.alternative,
      scope: options.scope,
      ...(options.supersedes ? { supersedesId: options.supersedes } : {}),
    })));
  });

program
  .command("search")
  .description("Search events, decisions, and handoffs")
  .argument("<query>", "Search query")
  .option("--limit <count>", "Maximum results", "10")
  .option("--kind <kind>", "event, decision, or handoff", collect, [])
  .action((query: string, options: { limit: string; kind: SearchResult["kind"][] }) => {
    const repo = program.opts<{ repo: string }>().repo;
    print(withStore(repo, (store) => store.searchMemory(query, Number(options.limit), options.kind)));
  });

program
  .command("context")
  .description("Compile a task-specific context pack")
  .argument("<task>", "Task description")
  .option("--budget <tokens>", "Approximate token budget", "5000")
  .action((task: string, options: { budget: string }) => {
    const repo = program.opts<{ repo: string }>().repo;
    print(withStore(repo, (store) => store.buildContext({ task, tokenBudget: Number(options.budget) })));
  });

program
  .command("handoff")
  .description("Create a Git-aware Markdown handoff and release leases")
  .requiredOption("--session <uuid>", "Agent session")
  .option("--task-id <uuid>", "Related task")
  .option("--title <title>", "Handoff title")
  .option("--notes <notes>", "Additional notes")
  .option("--keep-session", "Keep the session and leases active", false)
  .action((options: { session: string; taskId?: string; title?: string; notes?: string; keepSession: boolean }) => {
    const repo = program.opts<{ repo: string }>().repo;
    print(withStore(repo, (store) => store.createHandoff({
      sessionId: options.session,
      ...(options.taskId ? { taskId: options.taskId } : {}),
      ...(options.title ? { title: options.title } : {}),
      ...(options.notes ? { notes: options.notes } : {}),
      endSession: !options.keepSession,
    })));
  });

program.parseAsync().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
