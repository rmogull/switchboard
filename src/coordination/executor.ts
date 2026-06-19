import type { Logger } from "../core/logger.js";
import { shortId } from "../core/ids.js";
import type { Store } from "../state/db.js";
import type { CoordinationPhase } from "../state/types.js";
import { type CoordinationPlan, type Participant, validatePlan } from "./plan.js";

export interface ImplementInput {
  task: string;
  workingDir: string;
  iteration: number;
  coordinationId: string;
  /** Reviewer critique from the previous round, fed back for revision. */
  priorCritique?: string;
}
export interface ReviewInput {
  task: string;
  workingDir: string;
  diff: string;
  coordinationId: string;
}
export interface DecideInput {
  task: string;
  workingDir: string;
  diff: string;
  critique: string;
  coordinationId: string;
}

/**
 * The participant execution surface. Behind this interface a real implementation
 * spawns gated sessions and captures git diffs; tests pass a deterministic mock.
 * Crucially, NONE of these methods can land changes — only the executor calls
 * `land`, and only on a decider accept. The reviewer is structurally advisory.
 */
export interface ParticipantRunner {
  implement(p: Participant, input: ImplementInput): Promise<{ diff: string; summary?: string }>;
  review(p: Participant, input: ReviewInput): Promise<{ critique: string }>;
  decide(p: Participant, input: DecideInput): Promise<{ accept: boolean; reasoning: string }>;
  /** Land the accepted changes (commit/merge). Called ONLY by the executor on accept. */
  land(workingDir: string): Promise<void>;
  /** Discard in-progress changes when the loop converges without acceptance (optional). */
  discard?(workingDir: string): Promise<void>;
  /** Mark any registered participant sessions terminal when the run ends (optional). */
  finalize?(status?: "done" | "failed"): void;
}

export interface CoordinationResult {
  coordinationId: string;
  accepted: boolean;
  landed: boolean;
  iterations: number;
  finalDiff: string;
  decisionReasoning: string;
  /** Set by the Coordinator when an accepted change landed on a dedicated branch (repo runs). */
  landedBranch?: string;
}

export interface RunArgs {
  commandAuditId: number;
  task: string;
  workingDir: string;
  plan: CoordinationPlan;
  /** Optional caller-supplied id so the coordination id and its worktree branch match. */
  coordinationId?: string;
}

/**
 * Plan-then-execute coordination (§5.7). The model planned the topology; this
 * deterministic state machine runs it, moving artifacts (diff, critique) through
 * FIXED channels — a worker's output can never redirect control flow or escalate
 * authority (Invariant 4). It enforces, not the agents: decider-only landing,
 * advisory reviewer, provenance on every handoff, discrete logged re-plans.
 *
 *   planning → implementing → reviewing → revising → deciding → done
 *                   ▲                                    │
 *                   └──────────── reject (loop) ◀────────┘
 */
export class CoordinationExecutor {
  constructor(
    private readonly store: Store,
    private readonly runner: ParticipantRunner,
    private readonly log: Logger,
  ) {}

  private setPhase(coordinationId: string, phase: CoordinationPhase): void {
    this.store.coordination.setPhase(coordinationId, phase);
    this.store.audit.append({
      type: "status_change",
      coordinationId,
      source: "dispatcher",
      payload: { event: "phase", phase },
    });
  }

  /** Log an inter-agent artifact handoff with provenance (from → to, kind, size). */
  private handoff(coordinationId: string, from: string, to: string, kind: string, content: string): void {
    this.store.audit.append({
      type: "status_change",
      coordinationId,
      source: "dispatcher",
      payload: { event: "handoff", from, to, kind, bytes: content.length, preview: content.slice(0, 200) },
    });
  }

  async run(args: RunArgs): Promise<CoordinationResult> {
    validatePlan(args.plan);
    const participants = args.plan.participants;
    const implementer = participants.find((p) => p.role === "implementer")!;
    const reviewer = participants.find((p) => p.role === "reviewer");
    const decider = participants.find((p) => p.label === args.plan.decider)!;

    const coordinationId = args.coordinationId ?? shortId();
    this.store.coordination.create({
      id: coordinationId,
      commandAuditId: args.commandAuditId,
      topology: args.plan,
      phase: "planning",
    });
    this.store.audit.append({
      type: "status_change",
      coordinationId,
      source: "dispatcher",
      payload: { event: "plan", participants: participants.map((p) => `${p.label}:${p.role}:${p.client}`), decider: decider.label },
    });

    let critique: string | undefined;
    let diff = "";
    let accepted = false;
    let decisionReasoning = "";
    let iteration = 0;
    let totalRounds = 0;
    let replans = 0;
    let finishedCleanly = false;

    try {
    for (;;) {
      iteration++;
      totalRounds++;

      // — implement (first pass) / revise (subsequent) —
      this.setPhase(coordinationId, iteration === 1 ? "implementing" : "revising");
      const impl = await this.runner.implement(implementer, {
        task: args.task,
        workingDir: args.workingDir,
        iteration,
        coordinationId,
        ...(critique ? { priorCritique: critique } : {}),
      });
      diff = impl.diff;

      // — review (advisory; optional) —
      if (reviewer) {
        this.setPhase(coordinationId, "reviewing");
        this.handoff(coordinationId, implementer.label, reviewer.label, "diff", diff);
        const rev = await this.runner.review(reviewer, { task: args.task, workingDir: args.workingDir, diff, coordinationId });
        critique = rev.critique;
      } else {
        critique = "(no reviewer in plan)";
      }

      // — decide (the ONLY role that can land) —
      this.setPhase(coordinationId, "deciding");
      this.handoff(coordinationId, reviewer?.label ?? implementer.label, decider.label, "critique", critique);
      const decision = await this.runner.decide(decider, {
        task: args.task,
        workingDir: args.workingDir,
        diff,
        critique,
        coordinationId,
      });
      decisionReasoning = decision.reasoning;
      this.store.audit.append({
        type: "status_change",
        coordinationId,
        source: "dispatcher",
        payload: { event: "decision", by: decider.label, accept: decision.accept, reasoning: decision.reasoning.slice(0, 300) },
      });

      if (decision.accept) {
        // DECIDER-ONLY LANDING — structurally enforced: land() is reachable only here.
        await this.runner.land(args.workingDir);
        this.store.audit.append({
          type: "status_change",
          coordinationId,
          source: "dispatcher",
          payload: { event: "land", workingDir: args.workingDir },
        });
        accepted = true;
        break;
      }
      if (iteration >= args.plan.maxIterations) {
        if (replans < args.plan.maxReplans) {
          // Discrete, logged re-plan (§5.7): re-enter the implement→review→decide loop a
          // BOUNDED number of times. The topology is unchanged here — model-authored
          // re-planning would supply a new one — but the FSM re-entry, the `replanning`
          // phase, and the `replan` audit event are now real and bounded (no infinite loop).
          replans++;
          this.setPhase(coordinationId, "replanning");
          this.store.audit.append({
            type: "replan",
            coordinationId,
            source: "dispatcher",
            payload: { replan: replans, reason: "iteration limit without acceptance" },
          });
          iteration = 0;
          critique = undefined;
          continue;
        }
        this.log.info("coordination converged without acceptance (iteration + replan limits)", { coordinationId, totalRounds, replans });
        break;
      }
      // reject → loop back to revise with the critique fed forward.
    }

    // Inverse of land: nothing was accepted, so discard in-progress changes.
    if (!accepted) {
      await this.runner.discard?.(args.workingDir);
      this.store.audit.append({
        type: "status_change",
        coordinationId,
        source: "dispatcher",
        payload: { event: "discard", workingDir: args.workingDir },
      });
    }

    this.setPhase(coordinationId, "done");
    finishedCleanly = true;
    return {
      coordinationId,
      accepted,
      landed: accepted,
      iterations: totalRounds,
      finalDiff: diff,
      decisionReasoning,
    };
    } finally {
      // Mark participant sessions terminal even if the run threw mid-way — `failed`
      // on a crash (not the misleading `done`).
      this.runner.finalize?.(finishedCleanly ? "done" : "failed");
    }
  }
}
