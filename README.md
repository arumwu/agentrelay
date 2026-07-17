# AgentRelay

## One project. Multiple AI agents. Zero repeated work.

**Let AI continue where another AI stopped.**

It tracks active sessions, task leases, advisory file ownership, decisions, failed attempts, Git state, and handoffs so Codex, Claude Code, and other agents can continue each other's work without rebuilding context from scratch. Its built-in tmux transport also lets those agents read and message trusted panes without installing a second MCP server.

> Not another chat memory. A local coordination layer for coding agents.

## What works in v0.4.0

- Local-first SQLite storage inside a repository or workspace
- Fixed non-Git workspace boundaries with child-repository Git context
- MCP server with ten coordination tools and five live terminal tools
- Built-in tmux transport with no `tmux-bridge-mcp` runtime dependency
- One-session tmux boundary with pane labels and self-message prevention
- Redacted, size-limited terminal reads and single-line message sends
- Persistent read-before-send guards and content-free terminal audit events
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

## Install

AgentRelay is not published to npm yet.

Install the current GitHub repository as one self-contained CLI and MCP server:

```bash
npm install -g github:arumwu/agentrelay
agentrelay --version
```

Or install from a source checkout:

```bash
git clone https://github.com/arumwu/agentrelay.git
cd agentrelay
npm install
npm run build
npm link
```

Node.js 22.13 or newer is required. The coordination and memory features work without tmux; the live terminal tools additionally require tmux 3.2 or newer.

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

Configure AgentRelay in the actual Git repository where Codex starts. Create `.codex/config.toml` at that repository root:

```toml
[mcp_servers.agentrelay]
command = "agentrelay"
args = [
  "--repo",
  "/absolute/path/to/your/workspace",
  "serve"
]
```

Do not use a user-global `codex mcp add` unless you intentionally want every Codex session to start AgentRelay. Codex stops project-config discovery at the Git root, so a `.codex/config.toml` placed only in a parent multi-project workspace is not inherited when Codex starts directly inside a nested repository. Add the project config to each actual repository that should participate; all of them may still point to the same AgentRelay workspace boundary.

## Connect Claude Code

Run this from each actual repository and use local scope so unrelated Claude Code sessions do not start AgentRelay:

```bash
claude mcp add --scope local agentrelay -- \
  agentrelay \
  --repo /absolute/path/to/your/workspace \
  serve
```

AgentRelay advertises its lifecycle instructions through MCP initialization. For clients that do not consume server instructions, place the fallback rules from [`examples/AGENTS.md`](examples/AGENTS.md) in the repository's `AGENTS.md` or `CLAUDE.md`.

## Live tmux transport

AgentRelay includes the terminal transport directly. Installing `@arumwu/agentrelay` or the GitHub package is enough; do not install or register a separate `tmux-bridge-mcp` server.

Run the agents you want to coordinate in one tmux session. When AgentRelay starts inside tmux it automatically restricts terminal access to that current session:

```bash
agentrelay terminal list
agentrelay terminal name %3 codex
agentrelay terminal read codex --lines 40
agentrelay terminal send codex "Review src/auth.ts and report any regressions"
```

`terminal read` opens a 90-second, one-use guard for that actor and pane. After one send, read the pane again before sending another message. AgentRelay stores audit metadata such as the pane, byte count, and correlation ID, but never persists captured terminal output or message content.

If AgentRelay starts outside tmux, explicitly allow one session:

```bash
agentrelay terminal --tmux-session agent-work list
```

For MCP clients launched outside tmux, set `AGENTRELAY_TMUX_SESSION` in that server's environment. Set `AGENTRELAY_TMUX_SOCKET` only when using a non-default socket. Terminal targets outside the selected session are rejected.

`terminal_send` types one literal, single-line message followed by Enter. A shell pane can interpret that text as a command, so only label and target panes you trust. AgentRelay intentionally exposes no arbitrary key or generic shell-execution tool.

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
| `terminal_list` | List panes only in the allowed tmux session |
| `terminal_read` | Read redacted, capped pane output and open a one-use send guard |
| `terminal_send` | Send one literal single-line message and Enter after a recent read |
| `terminal_name` | Assign an AgentRelay-specific pane label |
| `terminal_doctor` | Diagnose tmux binary, socket, session, and safety limits |

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

Existing installations are migrated automatically to the `.agentrelay/agentrelay.db` storage layout on first startup.

## Coordination semantics

Task leases are exclusive while active. If a second agent requests the same task, AgentRelay returns a conflict with the current owner and expiry.

Scope claims are advisory. AgentRelay warns when file or glob patterns may overlap, but it does not pretend it can prevent an agent from editing files outside MCP. Agents and hooks should treat warnings as a coordination stop.

Decision conflicts are also advisory. AgentRelay flags related active decisions based on task, title, and scope overlap; a human or agent must explicitly supersede the old decision.

## Security boundaries

- The workspace root is resolved once when the server starts.
- Agent working directories must exist inside that fixed workspace.
- MCP tools cannot escape to another workspace path.
- AgentRelay does not expose a generic shell, arbitrary-key, or test-command tool.
- Terminal access is limited to the current or explicitly configured tmux session.
- Terminal sends require a recent read, reject self-targeting, and accept only one literal line.
- Terminal output is redacted and size-limited; captured output and message text are not persisted.
- Sending to a shell pane may still execute text, so terminal access is only for trusted panes.
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

The integration tests create temporary Git repositories and exercise task conflict, scope overlap, memory search, decision conflict, handoff generation, and a real in-memory MCP client/server handshake. When tmux is installed, they also create an isolated socket and verify real pane listing, labeling, read-before-send enforcement, messaging, self-target rejection, and cross-session isolation. CI always installs tmux and runs this path.

## Roadmap

- Agent-specific hooks for automatic lifecycle capture
- Git post-commit/post-merge adapters
- Task completion and blocked-state commands
- Optional semantic retrieval and reranking
- Portable redacted exports and repository sync
- GitHub issue and pull-request projections
- A small coordination dashboard

## License

AgentRelay is licensed under Apache License 2.0. See [LICENSE](LICENSE). The built-in terminal transport includes work adapted from MIT-declared `tmux-bridge-mcp`; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [LICENSES/tmux-bridge-mcp-MIT.txt](LICENSES/tmux-bridge-mcp-MIT.txt).
