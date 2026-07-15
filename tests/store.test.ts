import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectStore } from "../src/store.js";
import { createTestRepository, removeTestRepository } from "./helpers.js";

describe("ProjectStore multi-agent workflow", () => {
  let root: string;
  let store: ProjectStore;

  beforeEach(() => {
    root = createTestRepository();
    store = new ProjectStore(root, "fixture");
  });

  afterEach(() => {
    store.close();
    removeTestRepository(root);
  });

  it("coordinates task leases, advisory scopes, memory, context, and handoffs", () => {
    const codex = store.joinAgent({
      agentId: "codex-01",
      agentType: "codex",
      taskSummary: "Implement OAuth callback",
    });
    const claude = store.joinAgent({
      agentId: "claude-01",
      agentType: "claude-code",
      taskSummary: "Review authentication",
    });

    const claimed = store.claimTask({
      sessionId: codex.id,
      title: "Implement OAuth callback",
      description: "Add callback validation and tests",
      leaseMinutes: 30,
    }) as { claimed: boolean; task: { id: string } };
    expect(claimed.claimed).toBe(true);

    const conflict = store.claimTask({
      sessionId: claude.id,
      taskId: claimed.task.id,
      leaseMinutes: 30,
    }) as { claimed: boolean; conflict: { type: string } };
    expect(conflict.claimed).toBe(false);
    expect(conflict.conflict.type).toBe("task_conflict");

    store.claimScope({
      sessionId: codex.id,
      taskId: claimed.task.id,
      patterns: ["src/auth/**"],
    });
    const overlapping = store.claimScope({
      sessionId: claude.id,
      patterns: ["src/auth/callback.ts"],
    }) as { advisoryConflicts: unknown[] };
    expect(overlapping.advisoryConflicts).toHaveLength(1);

    const attempt = store.recordEvent({
      sessionId: codex.id,
      taskId: claimed.task.id,
      eventType: "attempt",
      summary: "Service account OAuth failed",
      content: "password=hunter2 is invalid because user OAuth is required",
      files: ["src/auth/callback.ts", ".env"],
      evidence: ["integration test invalid_grant"],
    }) as { content: string; files: string[] };
    expect(attempt.content).not.toContain("hunter2");
    expect(attempt.files).toEqual(["src/auth/callback.ts"]);

    store.recordEvent({
      sessionId: codex.id,
      taskId: claimed.task.id,
      eventType: "result",
      summary: "OAuth callback implemented",
      content: "Callback validation and token exchange are complete.",
      files: ["src/auth/callback.ts"],
    });
    store.recordEvent({
      sessionId: codex.id,
      taskId: claimed.task.id,
      eventType: "test",
      summary: "Authentication unit tests passed",
      content: "12 tests passed.",
    });

    const firstDecision = store.recordDecision({
      sessionId: codex.id,
      taskId: claimed.task.id,
      title: "Use encrypted user refresh tokens",
      decision: "Store encrypted refresh tokens in SQLite",
      reasons: ["User OAuth requires refresh capability"],
      alternatives: ["Service account"],
      scope: ["src/auth/**"],
    }) as { id: string };
    const secondDecision = store.recordDecision({
      sessionId: claude.id,
      title: "Use stateless OAuth tokens",
      decision: "Do not persist refresh tokens",
      scope: ["src/auth/callback.ts"],
    }) as { potentialConflicts: Array<{ id: string }> };
    expect(secondDecision.potentialConflicts.map((item) => item.id)).toContain(firstDecision.id);

    const search = store.searchMemory("service account OAuth", 10);
    expect(search.some((item) => item.title.includes("Service account"))).toBe(true);

    fs.mkdirSync(path.join(root, "src", "auth"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "auth", "callback.ts"), "export const callback = true;\n");
    fs.writeFileSync(path.join(root, ".env"), "SECRET=do-not-capture\n");

    const context = store.buildContext({
      task: "Finish OAuth callback",
      tokenBudget: 2_000,
    }) as { context: string; estimatedTokens: number };
    expect(context.context).toContain("AgentRelay Context Pack");
    expect(context.context).toContain("Service account OAuth failed");
    expect(context.context).not.toContain("do-not-capture");
    expect(context.estimatedTokens).toBeLessThanOrEqual(2_000);

    const handoff = store.createHandoff({
      sessionId: codex.id,
      taskId: claimed.task.id,
      title: "OAuth implementation handoff",
      notes: "Continue with refresh token rotation.",
    }) as { filePath: string; body: string; sessionEnded: boolean };
    expect(fs.existsSync(handoff.filePath)).toBe(true);
    expect(handoff.body).toContain("OAuth callback implemented");
    expect(handoff.body).toContain("src/auth/callback.ts");
    expect(handoff.body).not.toContain(".env");
    expect(handoff.sessionEnded).toBe(true);

    const reclaimed = store.claimTask({
      sessionId: claude.id,
      taskId: claimed.task.id,
      leaseMinutes: 30,
    }) as { claimed: boolean };
    expect(reclaimed.claimed).toBe(true);
    expect(store.searchMemory("OAuth implementation handoff", 10, ["handoff"])).toHaveLength(1);
  });

  it("projects task completion events into current task state", () => {
    const agent = store.joinAgent({ agentId: "codex-02", agentType: "codex" });
    const claimed = store.claimTask({
      sessionId: agent.id,
      title: "Finish migration",
    }) as { task: { id: string } };

    store.recordEvent({
      sessionId: agent.id,
      taskId: claimed.task.id,
      eventType: "task_completed",
      summary: "Migration finished",
      content: "Implementation and tests are complete.",
    });

    const status = store.projectStatus() as { openTasks: Array<{ id: string }> };
    expect(status.openTasks.map((task) => task.id)).not.toContain(claimed.task.id);
    expect(() =>
      store.claimTask({ sessionId: agent.id, taskId: claimed.task.id }),
    ).toThrow(/already completed/);
  });
});
