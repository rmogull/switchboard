import { SwitchboardError } from "../core/errors.js";
import type { Clock } from "../core/clock.js";
import { systemClock } from "../core/clock.js";
import type { Store } from "../state/db.js";
import { LearnedRulesStore, type LearnedRule } from "./rules.js";
import { detectCandidates, type Candidate } from "./suggestions.js";

export type ConfirmVia = "signal" | "dashboard" | "operator";

/**
 * The learning loop (Phase 6 / §5.6). Surfaces auto-allow candidates from the
 * approval history and promotes them ONLY on explicit operator confirmation —
 * every promotion is audit-logged with its source approvals, so there is no
 * silent policy drift. The promoted rules are honored by the permission policy.
 */
export class LearningService {
  constructor(
    private readonly store: Store,
    private readonly rules: LearnedRulesStore,
    private readonly threshold = 5,
    private readonly clock: Clock = systemClock,
  ) {}

  candidates(): Candidate[] {
    return detectCandidates(this.store, this.rules.load(), this.threshold);
  }

  rulesList(): LearnedRule[] {
    return this.rules.load();
  }

  /** Promote a candidate to a learned auto-allow rule, with audited provenance. */
  promote(candidateId: string, via: ConfirmVia = "operator"): LearnedRule {
    const candidate = this.candidates().find((c) => c.id === candidateId);
    if (!candidate) {
      throw new SwitchboardError("unknown_candidate", `no auto-allow candidate '${candidateId}'`);
    }
    const rule = this.rules.add({
      kind: candidate.kind,
      scope: candidate.scope,
      reason: candidate.description,
      sourceApprovalIds: candidate.approvalIds,
      createdAt: this.clock.now(),
    });
    this.store.audit.append({
      type: "memory_promotion",
      source: via === "dashboard" ? "dashboard" : "dispatcher",
      payload: { kind: "auto_allow", rule, fromApprovals: candidate.approvalIds.length, via },
    });
    return rule;
  }
}
