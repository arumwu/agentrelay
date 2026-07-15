import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function createTestRepository(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentrelay-test-"));
  const run = (args: string[]) => {
    const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
  };
  run(["init", "-b", "main"]);
  fs.writeFileSync(path.join(root, "README.md"), "# Fixture\n", "utf8");
  run(["add", "README.md"]);
  run([
    "-c",
    "user.name=AgentRelay Tests",
    "-c",
    "user.email=agentrelay@example.invalid",
    "commit",
    "-m",
    "initial fixture",
  ]);
  return root;
}

export function removeTestRepository(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}

export function createTestWorkspace(): { root: string; repository: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentrelay-workspace-test-"));
  const repository = path.join(root, "project-a");
  fs.mkdirSync(repository);
  const run = (args: string[]) => {
    const result = spawnSync("git", ["-C", repository, ...args], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
  };
  run(["init", "-b", "main"]);
  fs.writeFileSync(path.join(repository, "README.md"), "# Nested fixture\n", "utf8");
  run(["add", "README.md"]);
  run([
    "-c",
    "user.name=AgentRelay Tests",
    "-c",
    "user.email=agentrelay@example.invalid",
    "commit",
    "-m",
    "initial nested fixture",
  ]);
  return { root: fs.realpathSync(root), repository: fs.realpathSync(repository) };
}
