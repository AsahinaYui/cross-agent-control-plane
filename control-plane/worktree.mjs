import { mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { runCommand } from "./process.mjs";

async function git(repositoryRoot, args, timeoutMs = 120000) {
  const result = await runCommand({
    argv: ["git", "-C", repositoryRoot, ...args],
    cwd: repositoryRoot,
    timeoutMs,
  });
  if (result.exit_code !== 0)
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
    );
  return result.stdout.trim();
}
export async function inspectRepository(repositoryRoot) {
  const root = resolve(repositoryRoot),
    top = await git(root, ["rev-parse", "--show-toplevel"]),
    head = await git(root, ["rev-parse", "HEAD"]),
    status = await git(root, ["status", "--porcelain=v1"]);
  return { repository_root: resolve(top), head, status, clean: status === "" };
}
export async function createIsolatedWorktree({
  repositoryRoot,
  baseCommit,
  worktreesRoot,
  runId,
}) {
  return createMissionWorktree({
    repositoryRoot,
    baseCommit,
    worktreesRoot,
    workspaceId: runId,
  });
}
export async function createMissionWorktree({
  repositoryRoot,
  baseCommit,
  worktreesRoot,
  workspaceId,
}) {
  const info = await inspectRepository(repositoryRoot);
  if (info.head !== baseCommit)
    throw new Error(
      `Base commit mismatch: expected ${baseCommit}, observed ${info.head}`,
    );
  mkdirSync(worktreesRoot, { recursive: true });
  const path = join(
    resolve(worktreesRoot),
    `${basename(info.repository_root)}-${String(workspaceId).replace(/[^a-zA-Z0-9_-]/g, "-")}`,
  );
  await git(info.repository_root, [
    "worktree",
    "add",
    "--detach",
    path,
    baseCommit,
  ]);
  return {
    worktree_id: `wt_${workspaceId}`,
    worktree_path: path,
    base_commit: baseCommit,
  };
}
export async function captureGitEvidence(worktreePath, baseCommit) {
  const [status, diff, head, tracked] = await Promise.all([
    git(worktreePath, ["status", "--porcelain=v1"]),
    git(worktreePath, ["diff", "--binary", baseCommit, "--"]),
    git(worktreePath, ["rev-parse", "HEAD"]),
    git(worktreePath, ["diff", "--name-only", baseCommit, "--"]),
  ]);
  const untracked = status
    .split(/\r?\n/)
    .filter((line) => line.startsWith("?? "))
    .map((line) => line.slice(3).trim());
  const changedFiles = [
    ...new Set([...tracked.split(/\r?\n/).filter(Boolean), ...untracked]),
  ].sort();
  return {
    status,
    diff,
    head,
    base_commit: baseCommit,
    changed_files: changedFiles,
  };
}
