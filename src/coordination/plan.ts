import { z } from "zod";

import { SwitchboardError } from "../core/errors.js";

/**
 * Coordination plan (§5.7). The model AUTHORS the topology; this schema validates
 * it before any deterministic execution touches it. Roles are an open vocabulary
 * the model may compose, but every participant must resolve onto one of these
 * executor-understood primitives.
 */
export const ROLE_PRIMITIVES = ["implementer", "reviewer", "decider", "planner"] as const;
export type RolePrimitive = (typeof ROLE_PRIMITIVES)[number];

export const participantSchema = z.object({
  /** Stable handle used to route artifacts and name the decider. */
  label: z.string().min(1),
  role: z.enum(ROLE_PRIMITIVES),
  client: z.enum(["claude", "codex"]),
});

export const planSchema = z.object({
  participants: z.array(participantSchema).min(1),
  /** Label of the participant with landing authority. */
  decider: z.string().min(1),
  /** Hard bound on implement→review→revise loops before converging. */
  maxIterations: z.number().int().min(1).max(10).default(3),
  /** Hard bound on discrete re-plan re-entries after a loop converges without landing
   * (§5.7). 0 = never re-plan (the default — a single converge-or-discard pass). */
  maxReplans: z.number().int().min(0).max(5).default(0),
});

export type Participant = z.infer<typeof participantSchema>;
export type CoordinationPlan = z.infer<typeof planSchema>;

/**
 * Enforce the structural invariants a valid plan must satisfy before execution
 * (Invariant 7): the named decider exists and actually holds the `decider` role,
 * and there is at least one implementer. The reviewer is optional and ALWAYS
 * advisory — it has no landing authority regardless of what it outputs.
 */
export function validatePlan(plan: CoordinationPlan): void {
  const decider = plan.participants.find((p) => p.label === plan.decider);
  if (!decider) {
    throw new SwitchboardError("bad_plan", `decider '${plan.decider}' is not among the participants`);
  }
  if (decider.role !== "decider") {
    throw new SwitchboardError("bad_plan", `participant '${plan.decider}' must have role 'decider' to be the decider`);
  }
  if (!plan.participants.some((p) => p.role === "implementer")) {
    throw new SwitchboardError("bad_plan", "a plan needs at least one implementer");
  }
  const labels = plan.participants.map((p) => p.label);
  if (new Set(labels).size !== labels.length) {
    throw new SwitchboardError("bad_plan", "participant labels must be unique");
  }
}

/** Parse + validate a model-authored plan (unknown shape) into a CoordinationPlan. */
export function parsePlan(raw: unknown): CoordinationPlan {
  const parsed = planSchema.safeParse(raw);
  if (!parsed.success) {
    throw new SwitchboardError("bad_plan", `invalid coordination plan: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  }
  validatePlan(parsed.data);
  return parsed.data;
}

/** The canonical topology: Claude implements, Codex reviews, Claude decides (§5.7). */
export function canonicalPlan(maxIterations = 3, maxReplans = 0): CoordinationPlan {
  return {
    participants: [
      { label: "implementer", role: "implementer", client: "claude" },
      { label: "reviewer", role: "reviewer", client: "codex" },
      { label: "decider", role: "decider", client: "claude" },
    ],
    decider: "decider",
    maxIterations,
    maxReplans,
  };
}
