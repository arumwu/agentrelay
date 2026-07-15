# DevRelay agent protocol

This repository uses DevRelay as shared coordination state for coding agents.

## Before editing

1. Call `agent_join` with a stable agent ID, agent type, and concise task summary.
2. Call `build_context` for the intended task.
3. Call `agent_status` and inspect active agents, task leases, and scope claims.
4. Call `claim_task` before taking an existing or new task.
5. Call `claim_scope` for the files or modules you expect to modify.
6. Stop and coordinate if DevRelay reports a task conflict or relevant scope overlap.

## During work

- Heartbeat with `agent_status` before a lease expires.
- Record important discoveries, tests, results, and blockers with `record_event`.
- Record failed attempts with `event_type: attempt`, including the reason and retry condition.
- Record durable architecture choices with `record_decision`.
- Never store secrets, credentials, raw `.env` values, or private keys in DevRelay.

## Before ending or handing off

1. Record the latest test result and unresolved issues.
2. Record decisions that another agent would otherwise have to infer from the diff.
3. Call `create_handoff`; allow it to end the session unless work is continuing immediately.
4. Confirm the handoff includes changed files, test status, failed attempts, blockers, and the recommended next action.

DevRelay claims are coordination signals, not filesystem locks. Do not edit through an active overlapping claim without explicit coordination.
