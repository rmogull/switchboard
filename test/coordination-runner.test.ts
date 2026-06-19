import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseDecision } from "../src/coordination/runner.js";
import * as git from "../src/coordination/git.js";
import { Coordinator } from "../src/coordination/coordinator.js";
import type { ParticipantRunner } from "../src/coordination/executor.js";
import { canonicalPlan } from "../src/coordination/plan.js";
import { memoryStore } from "../src/state/db.js";
import { createLogger } from "../src/core/logger.js";
import { run } from "../src/execution/exec.js";
import type { ResolvedConfig } from "../src/config/index.js";

describe("parseDecision — fail closed", () => {
  it("parses explicit JSON decisions", () => {
    expect(parseDecision('{"accept": true, "reasoning": "lgtm"}')).toEqual({ accept: true, reasoning: "lgtm" });
    expect(parseDecision('prose then {"accept": false, "reasoning": "no"}').accept).toBe(false);
  });
  it("parses unambiguous keywords", () => {
    expect(parseDecision("I ACCEPT this change.").accept).toBe(true);
    expect(parseDecision("REJECT — needs work").accept).toBe(false);
  });
  it("fails closed (reject) on ambiguity or conflicting signals", () => {
    expect(parseDecision("hmm, not sure").accept).toBe(false);
    expect(parseDecision("I could ACCEPT or REJECT this").accept).toBe(false);
    expect(parseDecision("").accept).toBe(false);
  });
});

describe("git helper (real git)", () => {
  it("ensures a repo, diffs untracked changes, commits, and discards", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sw-git-"));
    await git.ensureRepo(dir);
    expect(await git.isGitRepo(dir)).toBe(true);

    writeFileSync(join(dir, "new.txt"), "hello coordinated\n");
    const diff = await git.gitDiff(dir);
    expect(diff).toContain("new.txt");
    expect(diff).toContain("hello coordinated");
    expect(await git.hasChanges(dir)).toBe(true);

    await git.commitAll(dir, "land it");
    expect(await git.hasChanges(dir)).toBe(false);

    writeFileSync(join(dir, "new.txt"), "MUTATED\n");
    writeFileSync(join(dir, "extra.txt"), "untracked\n");
    await git.discardChanges(dir);
    expect(readFileSync(join(dir, "new.txt"), "utf8")).toBe("hello coordinated\n");
    expect(existsSync(join(dir, "extra.txt"))).toBe(false);
  });
});

describe("Coordinator worktree isolation — never mutates the user's checkout", () => {
  const log = createLogger("error");

  // A faithful stand-in for the real runner's git side effects: the implementer
  // writes a file in the (isolated) working dir; land/discard delegate to git
  // exactly as RealParticipantRunner does. `failLand` simulates a commit failure.
  function mockRunner(decisions: boolean[], failLand = false): ParticipantRunner {
    return {
      async implement(_p, input) {
        writeFileSync(join(input.workingDir, "coordinated.txt"), "from-coordination\n");
        return { diff: await git.gitDiff(input.workingDir) };
      },
      async review() {
        return { critique: "ok" };
      },
      async decide() {
        return { accept: decisions.shift() ?? false, reasoning: "test" };
      },
      async land(workingDir) {
        if (failLand) throw new Error("simulated land/commit failure");
        await git.commitAll(workingDir, "coordinated change");
      },
      async discard(workingDir) {
        await git.discardChanges(workingDir);
      },
    };
  }

  /** A real git repo with a committed file, a DIRTY uncommitted change, and an untracked file. */
  async function dirtyRepo(): Promise<string> {
    const repo = mkdtempSync(join(tmpdir(), "sw-coord-repo-"));
    await git.ensureRepo(repo);
    writeFileSync(join(repo, "tracked.txt"), "v1\n");
    await git.commitAll(repo, "seed");
    writeFileSync(join(repo, "tracked.txt"), "DIRTY-UNCOMMITTED\n"); // uncommitted edit
    writeFileSync(join(repo, "untracked.txt"), "PRECIOUS\n"); // untracked file
    return repo;
  }

  function coordinatorFor(decisions: boolean[], failLand = false) {
    const stateDir = mkdtempSync(join(tmpdir(), "sw-coord-state-"));
    const cfg = { stateDir, repos: {} } as unknown as ResolvedConfig;
    const store = memoryStore();
    const commandAuditId = store.audit.append({ type: "command", source: "signal:+1" });
    return { coord: new Coordinator(store, cfg, log, mockRunner(decisions, failLand)), commandAuditId };
  }

  async function branchesMatching(repo: string, glob: string): Promise<string[]> {
    const r = await run("git", ["-C", repo, "branch", "--list", glob, "--format=%(refname:short)"]);
    return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  }

  it("REJECT path leaves the user's dirty + untracked work intact", async () => {
    const repo = await dirtyRepo();
    const { coord, commandAuditId } = coordinatorFor([false]);
    const r = await coord.run({ task: "do X", commandAuditId, workingDir: repo, plan: canonicalPlan(1) });

    expect(r.accepted).toBe(false);
    // The user's uncommitted edit and untracked file survive the destructive reject path.
    expect(readFileSync(join(repo, "tracked.txt"), "utf8")).toBe("DIRTY-UNCOMMITTED\n");
    expect(existsSync(join(repo, "untracked.txt"))).toBe(true);
    // The coordination never wrote into the user's checkout.
    expect(existsSync(join(repo, "coordinated.txt"))).toBe(false);
  });

  it("ACCEPT path lands on a dedicated branch, leaving the checkout untouched", async () => {
    const repo = await dirtyRepo();
    const { coord, commandAuditId } = coordinatorFor([true]);
    const r = await coord.run({ task: "do X", commandAuditId, workingDir: repo });

    expect(r.accepted).toBe(true);
    expect(r.landedBranch).toBe(`switchboard/coord-${r.coordinationId}`);
    // The change lives on the branch, not the working tree.
    const branch = await run("git", ["-C", repo, "rev-parse", "--verify", r.landedBranch!]);
    expect(branch.code).toBe(0);
    const onBranch = await run("git", ["-C", repo, "show", `${r.landedBranch}:coordinated.txt`]);
    expect(onBranch.stdout).toContain("from-coordination");
    // The user's checkout is exactly as they left it — dirty edit, untracked file, no coordinated.txt.
    expect(readFileSync(join(repo, "tracked.txt"), "utf8")).toBe("DIRTY-UNCOMMITTED\n");
    expect(existsSync(join(repo, "untracked.txt"))).toBe(true);
    expect(existsSync(join(repo, "coordinated.txt"))).toBe(false);
  });

  it("preserves the relative subdir for a subdirectory target", async () => {
    const repo = await dirtyRepo();
    writeFileSync(join(repo, "tracked.txt"), "v1\n"); // un-dirty so worktree add is clean enough
    const pkg = join(repo, "pkg");
    mkdirSync(pkg);
    writeFileSync(join(pkg, "seed.txt"), "pkg\n");
    await git.commitAll(repo, "add pkg");

    const { coord, commandAuditId } = coordinatorFor([true]);
    const r = await coord.run({ task: "do X", commandAuditId, workingDir: pkg });

    expect(r.accepted).toBe(true);
    // The coordinated file landed at pkg/coordinated.txt on the branch — subdir preserved.
    const onBranch = await run("git", ["-C", repo, "show", `${r.landedBranch}:pkg/coordinated.txt`]);
    expect(onBranch.code).toBe(0);
    expect(onBranch.stdout).toContain("from-coordination");
    // Not in the user's checkout.
    expect(existsSync(join(pkg, "coordinated.txt"))).toBe(false);
  });

  it("fails clearly on an unborn repo (no commits) instead of corrupting setup", async () => {
    const repo = mkdtempSync(join(tmpdir(), "sw-coord-unborn-"));
    await run("git", ["-C", repo, "init", "-q"]); // a repo with NO commits → no HEAD
    const { coord, commandAuditId } = coordinatorFor([true]);
    await expect(coord.run({ task: "do X", commandAuditId, workingDir: repo })).rejects.toThrow(/no commits/);
  });

  it("PRESERVES the worktree + branch when land/commit fails (no blind teardown)", async () => {
    const repo = await dirtyRepo();
    const { coord, commandAuditId } = coordinatorFor([true], /*failLand*/ true);
    await expect(coord.run({ task: "do X", commandAuditId, workingDir: repo })).rejects.toThrow(/land/);

    // The crash must NOT tear down the work: the coordination branch + worktree survive for recovery.
    expect((await branchesMatching(repo, "switchboard/coord-*")).length).toBe(1);
    const wt = await run("git", ["-C", repo, "worktree", "list", "--porcelain"]);
    expect((wt.stdout.match(/^worktree /gm) ?? []).length).toBeGreaterThan(1);
    // And the user's checkout is still untouched.
    expect(readFileSync(join(repo, "tracked.txt"), "utf8")).toBe("DIRTY-UNCOMMITTED\n");
    expect(existsSync(join(repo, "untracked.txt"))).toBe(true);
  });
});

describe("coordination participant FK — a gated approval no longer crashes", () => {
  it("accepts an approval against a REGISTERED participant session; the old unregistered id violates the FK", () => {
    const store = memoryStore();
    const auditId = store.audit.append({ type: "command", source: "signal:+1" });
    store.coordination.create({ id: "co1", commandAuditId: auditId, topology: canonicalPlan() });
    // What ensureSession() now does: a real sessions row for the participant.
    store.sessions.create({
      id: "coord-implementer-x", client: "claude", mode: "coordinated", role: "implementer",
      workingDir: "/w", status: "running", coordinationId: "co1", backend: "claude_sdk",
    });
    // An ask-path approval against the registered participant now succeeds (FK satisfied).
    expect(() =>
      store.approvals.create({ id: "apc", sessionId: "coord-implementer-x", toolName: "Bash", request: { command: "curl x" } }),
    ).not.toThrow();
    // The OLD behavior — a synthetic, unregistered id — violates the approvals→sessions FK.
    expect(() =>
      store.approvals.create({ id: "apc2", sessionId: "coord-unregistered-yyy", toolName: "Bash", request: {} }),
    ).toThrow();
  });
});

describe("git worktree safety — branch -d never discards an accepted commit", () => {
  it("removeWorktree(keepBranch=false) keeps a branch that holds commits, deletes an empty one", async () => {
    const repo = mkdtempSync(join(tmpdir(), "sw-wt-"));
    await git.ensureRepo(repo);
    const stateDir = mkdtempSync(join(tmpdir(), "sw-wt-state-"));

    // Branch WITH a commit (simulates a landed-then-crashed run): must survive teardown.
    const wtA = join(stateDir, "wtA");
    await git.addWorktree(repo, wtA, "switchboard/coord-A");
    writeFileSync(join(wtA, "landed.txt"), "accepted\n");
    await git.commitAll(wtA, "landed change");
    await git.removeWorktree(repo, wtA, "switchboard/coord-A", /*keepBranch*/ false);
    const a = await run("git", ["-C", repo, "branch", "--list", "switchboard/coord-A"]);
    expect(a.stdout.trim()).not.toBe(""); // -d refused: accepted commit preserved

    // Branch with NO commits (a normal reject): deleted cleanly.
    const wtB = join(stateDir, "wtB");
    await git.addWorktree(repo, wtB, "switchboard/coord-B");
    await git.removeWorktree(repo, wtB, "switchboard/coord-B", /*keepBranch*/ false);
    const b = await run("git", ["-C", repo, "branch", "--list", "switchboard/coord-B"]);
    expect(b.stdout.trim()).toBe("");
  });
});
