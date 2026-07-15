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
  const root = tryResolveRepositoryRoot(resolved);
  if (!root) {
    throw new Error(`Not a Git repository: ${resolved}`);
  }
  return root;
}

export function tryResolveRepositoryRoot(inputPath: string): string | null {
  const resolved = path.resolve(inputPath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) return null;
  const root = runGit(resolved, ["rev-parse", "--show-toplevel"], true);
  return root ? fs.realpathSync(root) : null;
}

export function resolveWorkspaceRoot(inputPath: string): string {
  const resolved = path.resolve(inputPath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`Workspace directory does not exist: ${resolved}`);
  }
  const realPath = fs.realpathSync(resolved);
  return tryResolveRepositoryRoot(realPath) ?? realPath;
}

export function resolveWorkingDirectory(workspaceRoot: string, inputPath?: string): string {
  const candidate = inputPath
    ? path.resolve(workspaceRoot, inputPath)
    : workspaceRoot;
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) {
    throw new Error(`Working directory does not exist: ${candidate}`);
  }
  const realPath = fs.realpathSync(candidate);
  const relative = path.relative(workspaceRoot, realPath);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Working directory is outside the DevRelay workspace: ${realPath}`);
  }
  return realPath;
}

export function captureGitSnapshot(rootPath: string): GitSnapshot {
  const repositoryRoot = tryResolveRepositoryRoot(rootPath);
  if (!repositoryRoot) {
    return {
      available: false,
      repositoryRoot: null,
      branch: "(no git repository)",
      head: null,
      status: [],
      changedFiles: [],
      diffStat: "",
      recentCommit: null,
      reason: "The selected working directory is not inside a Git repository.",
    };
  }
  const branch = runGit(repositoryRoot, ["branch", "--show-current"], true) || "(detached)";
  const head = runGit(repositoryRoot, ["rev-parse", "HEAD"], true) || null;
  const rawStatus = runGit(repositoryRoot, ["status", "--short", "--untracked-files=normal"], true);
  const status = rawStatus ? rawStatus.split("\n") : [];
  const rawChangedFiles = runGit(repositoryRoot, ["diff", "--name-only", "HEAD"], true);
  const untracked = runGit(repositoryRoot, ["ls-files", "--others", "--exclude-standard"], true);
  const changedFiles = filterSafePaths(
    [...rawChangedFiles.split("\n"), ...untracked.split("\n")].filter(Boolean),
  );
  const diffStat = runGit(repositoryRoot, ["diff", "--stat", "HEAD"], true);
  const recentCommit = runGit(repositoryRoot, ["log", "-1", "--pretty=format:%h %s"], true) || null;

  return {
    available: true,
    repositoryRoot,
    branch,
    head,
    status: status.filter((line) => {
      const candidatePath = line.slice(3).split(" -> ").at(-1) ?? "";
      return !candidatePath || filterSafePaths([candidatePath]).length > 0;
    }),
    changedFiles,
    diffStat,
    recentCommit,
    reason: null,
  };
}
