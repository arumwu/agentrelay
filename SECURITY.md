# Security policy

## Supported versions

DevRelay is pre-1.0 software. Security fixes are applied to the latest released version.

## Reporting a vulnerability

Do not open a public issue for a vulnerability that could expose local files, secrets, or command execution. Use GitHub's private vulnerability reporting for this repository.

Include the affected version, operating system, reproduction steps, security impact, and whether the issue requires a malicious MCP client, repository content, or local user.

## Threat model

DevRelay assumes coding agents and repository content may produce inaccurate or adversarial text. Stored memory is treated as context, not executable instructions.

The v0.1 boundary is intentionally narrow:

- one fixed repository or workspace boundary per server process
- local SQLite and Markdown storage
- no arbitrary shell command tool
- fixed Git command argument arrays
- workspace-relative scope paths only
- path traversal and absolute-path rejection
- sensitive filename filtering
- best-effort secret redaction before persistence

Secret redaction is defense in depth, not a substitute for avoiding secret input. Users should not intentionally send credentials to DevRelay.

## Out of scope for v0.1

- hostile local users with filesystem access to `.devrelay/`
- full-disk compromise
- malicious changes to the DevRelay executable or dependencies
- perfect detection of every possible credential format
- enforcing scope claims against tools that bypass DevRelay
