# Security policy

## Supported versions

AgentRelay is pre-1.0 software. Security fixes are applied to the latest released version.

## Reporting a vulnerability

Do not open a public issue for a vulnerability that could expose local files, secrets, or command execution. Use GitHub's private vulnerability reporting for this repository.

Include the affected version, operating system, reproduction steps, security impact, and whether the issue requires a malicious MCP client, repository content, or local user.

## Threat model

AgentRelay assumes coding agents and repository content may produce inaccurate or adversarial text. Stored memory is treated as context, not executable instructions.

The boundary is intentionally narrow:

- one fixed repository or workspace boundary per server process
- local SQLite and Markdown storage
- no generic shell, arbitrary-key, or test-command tool
- fixed Git command argument arrays
- workspace-relative scope paths only
- path traversal and absolute-path rejection
- sensitive filename filtering
- best-effort secret redaction before persistence
- one allowed tmux session per server process
- one-use, actor-and-pane-specific read-before-send guards
- single-line terminal messages with byte limits and self-target rejection
- redacted and size-limited terminal reads
- terminal audit metadata that excludes captured output and message text

Secret redaction is defense in depth, not a substitute for avoiding secret input. Users should not intentionally send credentials to AgentRelay.

`terminal_send` types literal text followed by Enter. If the target is a shell pane, that text can execute as a command. Only expose AgentRelay to trusted MCP clients, use a dedicated tmux session, label intended agent panes, inspect the pane with `terminal_read`, and do not target unrelated shells or production consoles.

## Out of scope

- hostile local users with filesystem access to `.agentrelay/`
- full-disk compromise
- malicious changes to the AgentRelay executable or dependencies
- malicious or compromised processes already running inside the allowed tmux session
- perfect detection of every possible credential format
- enforcing scope claims against tools that bypass AgentRelay
