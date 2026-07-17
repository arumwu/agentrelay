# Third-party notices

AgentRelay is licensed under Apache-2.0. The built-in tmux transport also adapts
the public behavior and selected implementation ideas of the following project.

## tmux-bridge-mcp

- Project: `tmux-bridge-mcp`
- Author and current contributor: Howard Peng (`howardpen9`)
- Upstream: https://github.com/howardpen9/tmux-bridge-mcp
- Reviewed revision: `eccf41bc1ab89a12d9c7540fcbf6d00e7161ff5c`
- Upstream package version: `0.3.0`
- Declared license: MIT in the upstream `package.json`

The upstream repository did not contain a root `LICENSE` file at the reviewed
revision. AgentRelay therefore reproduces the standard MIT license text in
[`LICENSES/tmux-bridge-mcp-MIT.txt`](LICENSES/tmux-bridge-mcp-MIT.txt) and keeps
this provenance notice with source and package distributions. Copyright in the
upstream work remains with its author and contributors.

AgentRelay's integration uses its own `terminal_*` interface and adds a single
tmux-session boundary, redaction and output limits, persistent read-before-send
guards, audit metadata, self-message prevention, and no arbitrary key tool.
