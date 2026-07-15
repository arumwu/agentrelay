import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectStore } from "../src/store.js";
import { createTestWorkspace, removeTestRepository } from "./helpers.js";

describe("workspace mode", () => {
  let root: string;
  let repository: string;
  let store: ProjectStore;

  beforeEach(() => {
    const fixture = createTestWorkspace();
    root = fixture.root;
    repository = fixture.repository;
    store = new ProjectStore(root, "multi-project-workspace");
  });

  afterEach(() => {
    store.close();
    removeTestRepository(root);
  });

  it("coordinates a non-Git workspace while using session-specific child Git state", () => {
    const initialized = store.initSummary() as {
      mode: string;
      git: { available: boolean };
      security: { workspaceBoundary: string };
    };
    expect(initialized.mode).toBe("workspace");
    expect(initialized.git.available).toBe(false);
    expect(initialized.security.workspaceBoundary).toBe(root);

    const session = store.joinAgent({
      agentId: "codex-workspace",
      agentType: "codex",
      workingDirectory: "project-a",
      taskSummary: "Edit the nested repository",
    });
    expect(session.workingPath).toBe(repository);
    expect(session.branch).toBe("main");

    fs.mkdirSync(path.join(repository, "src"));
    fs.writeFileSync(path.join(repository, "src", "index.ts"), "export const ready = true;\n");

    const context = store.buildContext({
      task: "Finish project A",
      workingDirectory: repository,
      tokenBudget: 2_000,
    }) as { context: string };
    expect(context.context).toContain(`"repositoryRoot": "${repository}"`);
    expect(context.context).toContain("src/index.ts");

    const handoff = store.createHandoff({
      sessionId: session.id,
      title: "Nested repository handoff",
    }) as { body: string; git: { available: boolean } };
    expect(handoff.git.available).toBe(true);
    expect(handoff.body).toContain("project-a/src/index.ts");
  });

  it("rejects a session working directory outside the fixed workspace", () => {
    expect(() =>
      store.joinAgent({
        agentId: "outside-agent",
        agentType: "other",
        workingDirectory: os.tmpdir(),
      }),
    ).toThrow(/outside the AgentRelay workspace/);
  });

  it("migrates legacy DevRelay storage without changing project identity", () => {
    const projectId = store.project.id;
    store.close();
    const newDirectory = path.join(root, ".agentrelay");
    const legacyDirectory = path.join(root, ".devrelay");
    fs.renameSync(newDirectory, legacyDirectory);
    fs.renameSync(
      path.join(legacyDirectory, "agentrelay.db"),
      path.join(legacyDirectory, "devrelay.db"),
    );

    store = new ProjectStore(root);

    expect(store.project.id).toBe(projectId);
    expect(fs.existsSync(path.join(root, ".agentrelay", "agentrelay.db"))).toBe(true);
    expect(fs.existsSync(legacyDirectory)).toBe(false);
  });
});
