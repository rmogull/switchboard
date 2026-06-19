import { run, runOk } from "../execution/exec.js";

/**
 * Minimal git plumbing for coordinated tasks (§5.7). Changes accumulate in the
 * working dir across implement/revise rounds; the executor captures the diff to
 * route to the reviewer, and commits ("lands") only on a decider accept — or
 * discards on convergence-without-accept. Identity is pinned per-invocation so it
 * never depends on (or mutates) the user's global git config.
 */
const IDENT = ["-c", "user.email=switchboard@local", "-c", "user.name=Switchboard"];

export async function isGitRepo(dir: string): Promise<boolean> {
  const r = await run("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"]);
  return r.code === 0 && r.stdout.trim() === "true";
}

/** Ensure `dir` is a git repo with at least one commit, so diffs have a base. */
export async function ensureRepo(dir: string): Promise<void> {
  if (await isGitRepo(dir)) return;
  await runOk("git", ["-C", dir, "init", "-q"]);
  await run("git", ["-C", dir, "add", "-A"]);
  await run("git", ["-C", dir, ...IDENT, "commit", "-q", "--allow-empty", "-m", "switchboard: baseline"]);
}

/** All changes vs HEAD, including untracked files (intent-to-add makes them show). */
export async function gitDiff(dir: string): Promise<string> {
  await run("git", ["-C", dir, "add", "-A", "-N"]);
  const r = await run("git", ["-C", dir, "diff", "HEAD"]);
  return r.stdout;
}

export async function hasChanges(dir: string): Promise<boolean> {
  const r = await run("git", ["-C", dir, "status", "--porcelain"]);
  return r.stdout.trim().length > 0;
}

/** True if the repo has at least one commit (a valid HEAD to branch a worktree from). */
export async function hasHead(dir: string): Promise<boolean> {
  const r = await run("git", ["-C", dir, "rev-parse", "--verify", "-q", "HEAD"]);
  return r.code === 0;
}

/** Absolute path of the repo's top-level working tree (for subdir-scoped targets). */
export async function repoToplevel(dir: string): Promise<string> {
  const r = await runOk("git", ["-C", dir, "rev-parse", "--show-toplevel"]);
  return r.stdout.trim();
}

/**
 * The target's path RELATIVE to the repo top-level ("" at the root, "pkg" in a
 * subdir). Uses git's own `--show-prefix` so it stays correct across symlinked
 * paths (e.g. macOS /var → /private/var) where a manual `relative()` would not.
 */
export async function repoPrefix(dir: string): Promise<string> {
  const r = await runOk("git", ["-C", dir, "rev-parse", "--show-prefix"]);
  return r.stdout.trim().replace(/\/+$/, "");
}

/**
 * Land: commit everything (the decider accepted). Commit failure is FATAL —
 * `runOk` throws so the caller never treats an unlanded change as accepted (a
 * silent failure here, combined with worktree teardown, would lose the work).
 */
export async function commitAll(dir: string, message: string): Promise<void> {
  await runOk("git", ["-C", dir, "add", "-A"]);
  await runOk("git", ["-C", dir, ...IDENT, "commit", "-q", "-m", message]);
}

/** Discard: revert tracked changes and remove untracked (no acceptance). */
export async function discardChanges(dir: string): Promise<void> {
  await run("git", ["-C", dir, "checkout", "--", "."]);
  await run("git", ["-C", dir, "clean", "-fd"]);
}

/**
 * Coordinated work must NEVER mutate the user's live working tree: the reject path
 * runs `git checkout -- . && git clean -fd`, which would destroy any uncommitted or
 * untracked work there. For a real repo (with history) we therefore run coordination
 * in a dedicated LINKED WORKTREE on a fresh branch — the user's checkout is untouched
 * even on the destructive reject path. An accepted change lands as a commit on that
 * branch (the operator merges when ready); a rejected run removes the worktree and
 * deletes the branch. `git worktree add ... HEAD` requires the repo to have a commit.
 */
export async function addWorktree(repoDir: string, worktreeDir: string, branch: string): Promise<void> {
  await runOk("git", ["-C", repoDir, "worktree", "add", "-b", branch, worktreeDir, "HEAD"]);
}

/**
 * Tear down a coordination worktree; delete its branch unless the change landed.
 * Uses the SAFE `branch -d` (not `-D`): it refuses to delete a branch holding
 * commits not in the base, so even a mis-computed `keepBranch=false` can never
 * discard an accepted commit — a belt-and-suspenders backstop on the cleanup path.
 */
export async function removeWorktree(
  repoDir: string,
  worktreeDir: string,
  branch: string,
  keepBranch: boolean,
): Promise<void> {
  // `runOk` so a genuine teardown failure (e.g. a locked worktree) surfaces to the
  // caller's log instead of silently leaking the worktree.
  await runOk("git", ["-C", repoDir, "worktree", "remove", "--force", worktreeDir]);
  // `run` (non-throwing): `branch -d` intentionally REFUSES (non-zero) when the branch
  // holds an unmerged commit — that refusal is the desired accepted-commit backstop, so
  // it must not be treated as an error.
  if (!keepBranch) await run("git", ["-C", repoDir, "branch", "-d", branch]);
}
