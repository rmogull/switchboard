import type { ResolvedConfig } from "../config/index.js";
import type { Logger } from "../core/logger.js";
import { shortId } from "../core/ids.js";
import type { Store } from "../state/db.js";
import { run } from "../execution/exec.js";
import { runGatedQuery } from "../execution/gated-query.js";
import type {
  DecideInput,
  ImplementInput,
  ParticipantRunner,
  ReviewInput,
} from "./executor.js";
import type { Participant } from "./plan.js";
import * as git from "./git.js";

/**
 * Parse a decider's free-text into a structured accept/reject. Prefers an
 * explicit JSON object; falls back to unambiguous ACCEPT/REJECT keywords; and
 * FAILS CLOSED (reject) on anything ambiguous — never land on uncertainty.
 */
export function parseDecision(text: string): { accept: boolean; reasoning: string } {
  const json = text.match(/\{[^{}]*"accept"[^{}]*\}/s);
  if (json) {
    try {
      const o = JSON.parse(json[0]) as { accept?: unknown; reasoning?: unknown };
      if (typeof o.accept === "boolean") {
        return { accept: o.accept, reasoning: String(o.reasoning ?? "").slice(0, 500) };
      }
    } catch {
      // fall through to keyword parsing
    }
  }
  const upper = text.toUpperCase();
  const accept = /\bACCEPT\b/.test(upper);
  const reject = /\bREJECT\b/.test(upper);
  if (accept && !reject) return { accept: true, reasoning: text.trim().slice(0, 300) };
  if (reject && !accept) return { accept: false, reasoning: text.trim().slice(0, 300) };
  return { accept: false, reasoning: `ambiguous decision — failing closed to reject: ${text.trim().slice(0, 200)}` };
}

/**
 * Real participant execution (§5.7): Claude participants run gated SDK turns;
 * Codex participants run `codex exec` under a sandbox mode (read-only for the
 * advisory reviewer, workspace-write for an implementer). Artifacts are git diffs.
 * land/discard are the only state-mutating ops and are invoked solely by the FSM.
 */
export class RealParticipantRunner implements ParticipantRunner {
  constructor(
    private readonly store: Store,
    private readonly cfg: ResolvedConfig,
    private readonly log: Logger,
  ) {}

  /** label → registered sessions-row id (created once, reused across rounds). */
  private readonly participantSessions = new Map<string, string>();

  /**
   * Register a real `sessions` row for a participant (once), so a gated approval
   * `ask` satisfies the `approvals.session_id` FK instead of crashing, and the
   * participant is visible in the registry. The decider's id is recorded on the plan.
   */
  private ensureSession(p: Participant, coordinationId: string, workingDir: string): string {
    const cached = this.participantSessions.get(p.label);
    if (cached) return cached;
    const sid = `coord-${p.role}-${shortId()}`;
    this.store.sessions.create({
      id: sid,
      client: p.client,
      mode: "coordinated",
      role: p.role,
      workingDir,
      status: "running",
      coordinationId,
      backend: p.client === "claude" ? "claude_sdk" : "codex_cli",
    });
    this.store.audit.append({
      type: "spawn",
      source: "dispatcher",
      sessionId: sid,
      payload: { coordinated: true, role: p.role, client: p.client, coordinationId },
    });
    if (p.role === "decider") this.store.coordination.setDecider(coordinationId, sid);
    this.participantSessions.set(p.label, sid);
    return sid;
  }

  /** Mark all registered participant sessions terminal when the run ends — `failed`
   * when the coordination crashed mid-way, `done` on a clean finish. */
  finalize(status: "done" | "failed" = "done"): void {
    for (const sid of this.participantSessions.values()) {
      this.store.sessions.setStatus(sid, status);
    }
  }

  private async runCodex(prompt: string, dir: string, sandbox: "read-only" | "workspace-write"): Promise<string> {
    const bin = this.cfg.clients.codex.cliPath ?? "codex";
    const r = await run(
      bin,
      ["exec", "-c", `sandbox_mode=${sandbox}`, "-c", "approval_policy=never", "--cd", dir, prompt],
      { timeoutMs: 300_000 },
    );
    return r.stdout || r.stderr;
  }

  async implement(p: Participant, input: ImplementInput): Promise<{ diff: string }> {
    await git.ensureRepo(input.workingDir);
    const prompt = input.priorCritique
      ? `Revise your implementation to address this reviewer feedback. Edit files directly in the current working directory; do NOT commit.\n\nReviewer feedback:\n${input.priorCritique}\n\nOriginal task:\n${input.task}`
      : `Implement this task by editing files in the current working directory. Do NOT commit — just make the changes.\n\nTask:\n${input.task}`;
    const sid = this.ensureSession(p, input.coordinationId, input.workingDir);
    if (p.client === "claude") {
      await runGatedQuery({ prompt, workingDir: input.workingDir, sessionId: sid, store: this.store, cfg: this.cfg, log: this.log });
    } else {
      await this.runCodex(prompt, input.workingDir, "workspace-write");
    }
    return { diff: await git.gitDiff(input.workingDir) };
  }

  async review(p: Participant, input: ReviewInput): Promise<{ critique: string }> {
    const prompt = `You are a code reviewer with NO authority to change anything. Review this diff for correctness, bugs, and quality, and produce a concise critique. Do not modify files.\n\nTask:\n${input.task}\n\nDiff:\n${input.diff}`;
    const sid = this.ensureSession(p, input.coordinationId, input.workingDir);
    if (p.client === "codex") {
      return { critique: await this.runCodex(prompt, input.workingDir, "read-only") };
    }
    const r = await runGatedQuery({
      prompt,
      workingDir: input.workingDir,
      sessionId: sid,
      store: this.store,
      cfg: this.cfg,
      disallowedTools: ["Write", "Edit", "MultiEdit", "NotebookEdit"],
      log: this.log,
    });
    return { critique: r.text || r.result };
  }

  async decide(p: Participant, input: DecideInput): Promise<{ accept: boolean; reasoning: string }> {
    const prompt = `You are the DECIDER — the only role that can land this change. Given the implementation diff and the reviewer's critique, decide whether to accept. Respond with ONLY a JSON object: {"accept": true|false, "reasoning": "<one sentence>"}.\n\nTask:\n${input.task}\n\nDiff:\n${input.diff}\n\nReviewer critique:\n${input.critique}`;
    const sid = this.ensureSession(p, input.coordinationId, input.workingDir);
    const r = await runGatedQuery({
      prompt,
      workingDir: input.workingDir,
      sessionId: sid,
      store: this.store,
      cfg: this.cfg,
      disallowedTools: ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"],
      log: this.log,
    });
    return parseDecision(r.text || r.result);
  }

  async land(workingDir: string): Promise<void> {
    await git.commitAll(workingDir, "switchboard: coordinated change accepted by decider");
  }

  async discard(workingDir: string): Promise<void> {
    await git.discardChanges(workingDir);
  }
}
