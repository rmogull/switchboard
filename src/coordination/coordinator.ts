import { mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

import type { ResolvedConfig } from "../config/index.js";
import type { Logger } from "../core/logger.js";
import { shortId } from "../core/ids.js";
import { expandHome } from "../core/paths.js";
import { SwitchboardError } from "../core/errors.js";
import type { Store } from "../state/db.js";
import { CoordinationExecutor, type CoordinationResult, type ParticipantRunner } from "./executor.js";
import { RealParticipantRunner } from "./runner.js";
import * as git from "./git.js";
import { canonicalPlan, type CoordinationPlan } from "./plan.js";

export interface CoordinateArgs {
  task: string;
  commandAuditId: number;
  /** Named repo (from config.repos) to work in; otherwise an isolated scratch dir. */
  repo?: string;
  workingDir?: string;
  plan?: CoordinationPlan;
}

/**
 * Orchestrates a coordinated task end to end (§7.3): resolve the working dir,
 * pick the plan (default canonical), and drive the deterministic FSM with the
 * real participant runner. Default behavior is deliverable-mode (run to
 * convergence, then the caller notifies).
 */
export class Coordinator {
  constructor(
    private readonly store: Store,
    private readonly cfg: ResolvedConfig,
    private readonly log: Logger,
    /** Injectable for tests; defaults to the real gated participant runner. */
    private readonly runner?: ParticipantRunner,
  ) {}

  /**
   * Resolve an ISOLATED working dir for the run. Critically, coordination NEVER runs
   * in the user's live checkout: for a real repo we add a linked git worktree on a
   * fresh branch (so the destructive reject path `git checkout -- . && git clean -fd`
   * can never touch the user's uncommitted/untracked work). A subdir target keeps its
   * relative path inside the worktree. Non-repo targets are used as-is (legacy); only
   * the no-target case gets a fresh scratch dir. For worktree runs we return the branch
   * + worktree dir + a remover; the caller preserves them on a mid-run crash so accepted
   * work is never lost to teardown.
   */
  private async prepareWorkspace(
    args: CoordinateArgs,
    id: string,
  ): Promise<{
    workingDir: string;
    branch?: string;
    worktreeDir?: string;
    removeWorktree?: (keepBranch: boolean) => Promise<void>;
  }> {
    let target: string | undefined;
    if (args.repo) {
      const p = this.cfg.repos[args.repo];
      if (!p) throw new SwitchboardError("unknown_repo", `no repo '${args.repo}' in config.repos`);
      target = expandHome(p);
      if (!existsSync(target)) throw new SwitchboardError("missing_dir", `repo path missing: ${target}`);
    } else if (args.workingDir) {
      target = expandHome(args.workingDir);
    }

    // Real git repo → isolate in a linked worktree; never touch the user's checkout.
    if (target && (await git.isGitRepo(target))) {
      if (!(await git.hasHead(target))) {
        throw new SwitchboardError("unborn_repo", `repo '${target}' has no commits; make an initial commit before coordinating`);
      }
      const repoDir = await git.repoToplevel(target);
      const prefix = await git.repoPrefix(target); // "" when target IS the repo root
      const branch = `switchboard/coord-${id}`;
      const worktreeDir = join(this.cfg.stateDir, "worktrees", `coord-${id}`);
      mkdirSync(dirname(worktreeDir), { recursive: true });
      await git.addWorktree(repoDir, worktreeDir, branch);
      // A subdir present only in the user's dirty checkout won't exist in the HEAD-based
      // worktree; create it there so coordination can write into it (worktree is isolated).
      const workingDir = prefix ? join(worktreeDir, prefix) : worktreeDir;
      if (prefix) mkdirSync(workingDir, { recursive: true });
      return {
        workingDir,
        branch,
        worktreeDir,
        removeWorktree: async (keepBranch) => {
          try {
            await git.removeWorktree(repoDir, worktreeDir, branch, keepBranch);
          } catch (e) {
            this.log.error("coordination worktree cleanup failed", { worktreeDir, err: String(e) });
          }
        },
      };
    }

    // Non-git target → used as-is (legacy behavior). No target → throwaway scratch.
    if (target) return { workingDir: target };
    const dir = join(this.cfg.stateDir, "scratch", `coord-${id}`);
    mkdirSync(dir, { recursive: true });
    return { workingDir: dir };
  }

  async run(args: CoordinateArgs): Promise<CoordinationResult> {
    const id = shortId();
    const plan = args.plan ?? canonicalPlan();
    const { workingDir, branch, worktreeDir, removeWorktree } = await this.prepareWorkspace(args, id);
    const runner = this.runner ?? new RealParticipantRunner(this.store, this.cfg, this.log);
    const executor = new CoordinationExecutor(this.store, runner, this.log);
    this.log.info("coordination starting", {
      workingDir,
      branch,
      participants: plan.participants.map((p) => `${p.label}:${p.client}`),
      decider: plan.decider,
    });
    let result: CoordinationResult | undefined;
    try {
      result = await executor.run({ commandAuditId: args.commandAuditId, task: args.task, workingDir, plan, coordinationId: id });
      if (result.accepted && branch) result.landedBranch = branch;
      return result;
    } finally {
      if (removeWorktree) {
        if (result) {
          // Clean teardown: keep the branch only when the change actually landed.
          await removeWorktree(result.accepted);
        } else {
          // Mid-run crash (incl. a failed land): PRESERVE the worktree + branch so any
          // committed-or-in-progress work is recoverable rather than torn down blindly.
          this.log.error("coordination crashed mid-run; worktree preserved for recovery", { worktreeDir, branch });
        }
      }
    }
  }
}
