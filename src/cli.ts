#!/usr/bin/env node
import { Command, Option } from "commander";
import { serveStdio } from "./mcp.js";
import { ProjectStore } from "./store.js";
import { TerminalService, TerminalTransport } from "./terminal.js";
import type { AgentType, EventType, SearchResult } from "./types.js";
import { AGENTRELAY_VERSION } from "./version.js";

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

async function withTerminal<T>(
  repo: string,
  options: { tmuxSession?: string; tmuxSocket?: string },
  callback: (terminal: TerminalService) => Promise<T>,
): Promise<T> {
  const store = new ProjectStore(repo);
  const transport = new TerminalTransport({
    ...(options.tmuxSession ? { sessionName: options.tmuxSession } : {}),
    ...(options.tmuxSocket ? { socketPath: options.tmuxSocket } : {}),
  });
  try {
    return await callback(new TerminalService(store, transport));
  } finally {
    store.close();
  }
}

function auditContext(options: { agentSession?: string; taskId?: string }): {
  sessionId?: string;
  taskId?: string;
} {
  return {
    ...(options.agentSession ? { sessionId: options.agentSession } : {}),
    ...(options.taskId ? { taskId: options.taskId } : {}),
  };
}

const program = new Command()
  .name("agentrelay")
  .description("Local-first coordination, shared project memory, and live tmux transport for coding agents.")
  .version(AGENTRELAY_VERSION)
  .option("-r, --repo <path>", "Workspace or Git repository to coordinate", process.cwd());

program
  .command("init")
  .description("Initialize .agentrelay storage in the workspace")
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
  .description("Run the AgentRelay MCP server over stdio")
  .action(async () => {
    const repo = program.opts<{ repo: string }>().repo;
    await serveStdio(new ProjectStore(repo));
  });

program
  .command("join")
  .description("Register an agent session")
  .requiredOption("--agent <id>", "Stable agent identifier")
  .addOption(new Option("--type <type>", "Agent type").choices(["codex", "claude-code", "gemini-cli", "cursor", "cline", "other"]).default("other"))
  .option("--cwd <path>", "Current directory inside the workspace")
  .option("--task <summary>", "Current task summary")
  .action((options: { agent: string; type: AgentType; cwd?: string; task?: string }) => {
    const repo = program.opts<{ repo: string }>().repo;
    print(withStore(repo, (store) => store.joinAgent({
      agentId: options.agent,
      agentType: options.type,
      ...(options.cwd ? { workingDirectory: options.cwd } : {}),
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
  .option("--cwd <path>", "Current directory inside the workspace")
  .action((task: string, options: { budget: string; cwd?: string }) => {
    const repo = program.opts<{ repo: string }>().repo;
    print(withStore(repo, (store) => store.buildContext({
      task,
      tokenBudget: Number(options.budget),
      ...(options.cwd ? { workingDirectory: options.cwd } : {}),
    })));
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

const terminalCommand = program
  .command("terminal")
  .description("Coordinate trusted AI-agent panes through the built-in tmux transport")
  .option("--tmux-session <name>", "Allow only this tmux session; defaults to the current session")
  .option("--tmux-socket <path>", "Use an explicit tmux socket path");

function terminalOptions(): { tmuxSession?: string; tmuxSocket?: string } {
  const options = terminalCommand.opts<{ tmuxSession?: string; tmuxSocket?: string }>();
  return {
    ...(options.tmuxSession ? { tmuxSession: options.tmuxSession } : {}),
    ...(options.tmuxSocket ? { tmuxSocket: options.tmuxSocket } : {}),
  };
}

terminalCommand
  .command("list")
  .description("List panes in the allowed tmux session")
  .action(async () => {
    const repo = program.opts<{ repo: string }>().repo;
    print(await withTerminal(repo, terminalOptions(), (terminal) => terminal.list()));
  });

terminalCommand
  .command("read")
  .description("Read redacted pane output and open a short-lived send guard")
  .argument("<target>", "Pane id, tmux target, or AgentRelay pane label")
  .option("--lines <count>", "Lines to read, from 1 to 200", "50")
  .option("--agent-session <uuid>", "AgentRelay session for the audit event")
  .option("--task-id <uuid>", "AgentRelay task for the audit event")
  .action(async (target: string, options: { lines: string; agentSession?: string; taskId?: string }) => {
    const repo = program.opts<{ repo: string }>().repo;
    print(await withTerminal(
      repo,
      terminalOptions(),
      (terminal) => terminal.read(target, Number(options.lines), auditContext(options)),
    ));
  });

terminalCommand
  .command("send")
  .description("Send one literal message and Enter after a recent terminal read")
  .argument("<target>", "Pane id, tmux target, or AgentRelay pane label")
  .argument("<message>", "Single-line message, up to 8192 UTF-8 bytes")
  .option("--agent-session <uuid>", "AgentRelay session for the audit event")
  .option("--task-id <uuid>", "AgentRelay task for the audit event")
  .action(async (target: string, message: string, options: { agentSession?: string; taskId?: string }) => {
    const repo = program.opts<{ repo: string }>().repo;
    print(await withTerminal(
      repo,
      terminalOptions(),
      (terminal) => terminal.send(target, message, auditContext(options)),
    ));
  });

terminalCommand
  .command("name")
  .description("Assign an AgentRelay-specific label to a pane")
  .argument("<target>", "Pane id or tmux target")
  .argument("<label>", "Letters, numbers, dots, underscores, or hyphens")
  .option("--agent-session <uuid>", "AgentRelay session for the audit event")
  .option("--task-id <uuid>", "AgentRelay task for the audit event")
  .action(async (target: string, label: string, options: { agentSession?: string; taskId?: string }) => {
    const repo = program.opts<{ repo: string }>().repo;
    print(await withTerminal(
      repo,
      terminalOptions(),
      (terminal) => terminal.name(target, label, auditContext(options)),
    ));
  });

terminalCommand
  .command("doctor")
  .description("Diagnose tmux binary, socket, session, and safety limits")
  .action(async () => {
    const options = terminalOptions();
    const transport = new TerminalTransport({
      ...(options.tmuxSession ? { sessionName: options.tmuxSession } : {}),
      ...(options.tmuxSocket ? { socketPath: options.tmuxSocket } : {}),
    });
    print(await transport.doctor());
  });

program.parseAsync().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
