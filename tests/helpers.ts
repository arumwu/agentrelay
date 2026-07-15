import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function createTestRepository(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devrelay-test-"));
  const run = (args: string[]) => {
    const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
  };
  run(["init", "-b", "main"]);
  fs.writeFileSync(path.join(root, "README.md"), "# Fixture\n", "utf8");
  run(["add", "README.md"]);
  run([
    "-c",
    "user.name=DevRelay Tests",
    "-c",
    "user.email=devrelay@example.invalid",
    "commit",
    "-m",
    "initial fixture",
  ]);
  return root;
}

export function removeTestRepository(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}
