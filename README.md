# AgentRelay

## One project. Multiple AI agents. Zero repeated work.

**Let AI continue where another AI stopped.**

It tracks active sessions, task leases, advisory file ownership, decisions, failed attempts, Git state, and handoffs so Codex, Claude Code, and other agents can continue each other's work without rebuilding context from scratch.

> Not another chat memory. A local coordination layer for coding agents.

## What works in v0.3

- Local-first SQLite storage inside a repository or workspace
- Fixed non-Git workspace boundaries with child-repository Git context
- MCP server with ten focused tools
- Agent sessions and heartbeats
- Expiring task leases
- Advisory file and glob claims with overlap warnings
- Structured development events and architecture decisions
- Potential decision-conflict detection
- FTS5 search across events, decisions, and handoffs
- Token-budgeted context packs
- Deterministic Git-aware Markdown handoffs
- CLI fallback for agents without lifecycle hooks
- Secret redaction and sensitive-path filtering
- No external model or hosted service required

## The workflow

```text
Agent A joins
  -> claims a task and file scope
  -> records decisions, tests, and failed attempts
  -> creates a Git-aware handoff and releases its leases

Agent B joins
  -> builds a task-specific context pack
  -> sees prior attempts, decisions, tasks, and file claims
  -> claims the continuation and starts from verified project state
```

## Install from source

AgentRelay is not published to npm yet.

```bash
git clone https://github.com/arumwu/agentrelay.git
cd agentrelay
npm install
npm run build
npm link
```

Node.js 22.13 or newer is required.

## Quick start

Run these commands from a Git repository, or pin AgentRelay to a larger workspace with `--repo /absolute/path` before the subcommand.

```bash
agentrelay --repo /workspaces/company init
agentrelay --repo /workspaces/company join \
  --agent codex-01 \
  --type codex \
  --cwd products/api \
  --task "Implement OAuth callback"
```

The `join` command returns a session UUID. Use it for claims and event records:

```bash
agentrelay claim-task \
  --session SESSION_UUID \
  --title "Implement OAuth callback" \
  --description "Validate callback and exchange tokens"

agentrelay claim-scope \
  --session SESSION_UUID \
  --pattern "src/auth/**"

agentrelay event \
  --session SESSION_UUID \
  --type attempt \
  --summary "Service account approach failed" \
  --content "Normal user OAuth requires authorization-code flow"

agentrelay context "Finish OAuth refresh flow" --cwd products/api --budget 5000

agentrelay handoff \
  --session SESSION_UUID \
  --title "OAuth implementation handoff"
```

## Connect Codex

For a source checkout, register the built CLI and pin it to the repository or workspace the agents will coordinate:

```bash
codex mcp add agentrelay -- \
  node /absolute/path/to/agentrelay/dist/cli.js \
  --repo /absolute/path/to/your/workspace \
  serve
```

Equivalent `config.toml`:

```toml
[mcp_servers.agentrelay]
command = "node"
args = [
  "/absolute/path/to/agentrelay/dist/cli.js",
  "--repo",
  "/absolute/path/to/your/workspace",
  "serve"
]
```

## Connect Claude Code

```bash
claude mcp add agentrelay -- \
  node /absolute/path/to/agentrelay/dist/cli.js \
  --repo /absolute/path/to/your/workspace \
  serve
```

Then place the lifecycle rules from [`examples/AGENTS.md`](examples/AGENTS.md) in the repository's `AGENTS.md` or `CLAUDE.md`.

## Workspace mode

A workspace may contain many independent Git repositories and non-Git projects:

```text
/workspaces/company/             <- fixed AgentRelay boundary
├── .agentrelay/                 <- shared workspace memory
├── products/api/.git/
├── products/web/.git/
└── research-notes/
```

The MCP server remains fixed to `/workspaces/company`. Each `agent_join` and `build_context` call may include `working_directory`, such as `products/api`. AgentRelay rejects directories outside the fixed workspace and obtains Git status from the child repository containing that working directory.

Task and scope claims remain workspace-wide. In the example above, claim `products/api/src/**`, not only `src/**`, to avoid ambiguity between child projects.

## MCP tools

| Tool | Purpose |
|---|---|
| `project_init` | Initialize or inspect workspace-local storage and its fixed boundary |
| `agent_join` | Register an agent session and its current workspace directory |
| `agent_status` | Read coordination state and optionally heartbeat a session |
| `claim_task` | Create or claim an expiring task lease |
| `claim_scope` | Claim workspace-relative files or globs and receive overlap warnings |
| `record_event` | Record an attempt, result, issue, discovery, test, note, or completion |
| `record_decision` | Record a structured decision and identify potential conflicts |
| `search_memory` | Search events, decisions, and handoffs with SQLite FTS5 |
| `build_context` | Compile task-specific Git, coordination, and memory context |
| `create_handoff` | Generate a Markdown handoff and optionally release leases |

## Local data

Each coordinated repository or workspace owns its memory:

```text
.agentrelay/
├── agentrelay.db
├── events.jsonl
└── handoffs/
    └── 2026-...-handoff.md
```

`.agentrelay/` is excluded from this repository's Git history by default. In a non-Git workspace it remains a hidden local directory. A team may choose to version redacted handoff exports, but the database should normally remain local.

When upgrading from the former DevRelay name, the first AgentRelay startup automatically renames `.devrelay/` to `.agentrelay/` and `devrelay.db` to `agentrelay.db` when the new paths do not already exist.

## Coordination semantics

Task leases are exclusive while active. If a second agent requests the same task, AgentRelay returns a conflict with the current owner and expiry.

Scope claims are advisory. AgentRelay warns when file or glob patterns may overlap, but it does not pretend it can prevent an agent from editing files outside MCP. Agents and hooks should treat warnings as a coordination stop.

Decision conflicts are also advisory. AgentRelay flags related active decisions based on task, title, and scope overlap; a human or agent must explicitly supersede the old decision.

## Security boundaries

- The workspace root is resolved once when the server starts.
- Agent working directories must exist inside that fixed workspace.
- MCP tools cannot escape to another workspace path.
- AgentRelay does not expose arbitrary shell or test-command execution.
- Git inspection uses fixed argument arrays without a shell.
- `.env`, private keys, and credential-like paths are filtered.
- Common API keys, tokens, passwords, cookies, and bearer headers are redacted before storage.
- Agent-authored memory remains evidence-linked context, not trusted executable instructions.

See [SECURITY.md](SECURITY.md) for reporting and threat-model details.

## Development

```bash
npm install
npm run check
```

The integration tests create temporary Git repositories and exercise task conflict, scope overlap, memory search, decision conflict, handoff generation, and a real in-memory MCP client/server handshake.

## Roadmap

- Agent-specific hooks for automatic lifecycle capture
- Git post-commit/post-merge adapters
- Task completion and blocked-state commands
- Optional semantic retrieval and reranking
- Portable redacted exports and repository sync
- GitHub issue and pull-request projections
- A small coordination dashboard

## License

Apache License 2.0. See [LICENSE](LICENSE).
