import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { GitSnapshot } from "./types.js";
import { filterSafePaths, redactSecrets } from "./security.js";

const MAX_GIT_OUTPUT = 128 * 1024;

function runGit(rootPath: string, args: readonly string[], allowFailure = false): string {
  const result = spawnSync("git", ["-C", rootPath, ...args], {
    encoding: "utf8",
    maxBuffer: MAX_GIT_OUTPUT,
    timeout: 10_000,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  });

  if (result.error) {
    throw new Error(`Unable to run git: ${result.error.message}`);
  }
  if (result.status !== 0) {
    if (allowFailure) return "";
    throw new Error(redactSecrets(result.stderr.trim() || `git exited with ${result.status}`));
  }
  return redactSecrets(result.stdout.trim());
}

export function resolveRepositoryRoot(inputPath: string): string {
  const resolved = path.resolve(inputPath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`Repository directory does not exist: ${resolved}`);
  }
  const root = runGit(resolved, ["rev-parse", "--show-toplevel"], true);
  if (!root) {
    throw new Error(`Not a Git repository: ${resolved}`);
  }
  return fs.realpathSync(root);
}

export function captureGitSnapshot(rootPath: string): GitSnapshot {
  const branch = runGit(rootPath, ["branch", "--show-current"], true) || "(detached)";
  const head = runGit(rootPath, ["rev-parse", "HEAD"], true) || null;
  const rawStatus = runGit(rootPath, ["status", "--short", "--untracked-files=normal"], true);
  const status = rawStatus ? rawStatus.split("\n") : [];
  const rawChangedFiles = runGit(rootPath, ["diff", "--name-only", "HEAD"], true);
  const untracked = runGit(rootPath, ["ls-files", "--others", "--exclude-standard"], true);
  const changedFiles = filterSafePaths(
    [...rawChangedFiles.split("\n"), ...untracked.split("\n")].filter(Boolean),
  );
  const diffStat = runGit(rootPath, ["diff", "--stat", "HEAD"], true);
  const recentCommit = runGit(rootPath, ["log", "-1", "--pretty=format:%h %s"], true) || null;

  return {
    branch,
    head,
    status: status.filter((line) => {
      const candidatePath = line.slice(3).split(" -> ").at(-1) ?? "";
      return !candidatePath || filterSafePaths([candidatePath]).length > 0;
    }),
    changedFiles,
    diffStat,
    recentCommit,
  };
}
