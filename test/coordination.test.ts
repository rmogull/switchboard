import { describe, it, expect } from "vitest";

import { memoryStore } from "../src/state/db.js";
import { createLogger } from "../src/core/logger.js";
import { canonicalPlan, parsePlan, validatePlan } from "../src/coordination/plan.js";
import {
  CoordinationExecutor,
  type ImplementInput,
  type ParticipantRunner,
} from "../src/coordination/executor.js";

const log = createLogger("error");

class MockRunner implements ParticipantRunner {
  landed = 0;
  reviewCalls = 0;
  decideCalls = 0;
  readonly implementCalls: ImplementInput[] = [];
  constructor(private readonly decisions: boolean[]) {}
  async implement(_p: unknown, input: ImplementInput) {
    this.implementCalls.push(input);
    return { diff: `diff-iter-${input.iteration}` };
  }
  async review() {
    this.reviewCalls++;
    return { critique: "needs work" };
  }
  async decide() {
    this.decideCalls++;
    const accept = this.decisions.shift() ?? false;
    return { accept, reasoning: accept ? "lgtm" : "please revise" };
  }
  async land() {
    this.landed++;
  }
}

function harness(decisions: boolean[], maxIterations = 3) {
  const store = memoryStore();
  const commandAuditId = store.audit.append({ type: "command", source: "signal:+1" });
  const runner = new MockRunner(decisions);
  const ex = new CoordinationExecutor(store, runner, log);
  const plan = canonicalPlan(maxIterations);
  return {
    store,
    runner,
    run: () => ex.run({ commandAuditId, task: "implement feature X", workingDir: "/w", plan }),
  };
}

function eventsFor(store: ReturnType<typeof memoryStore>, coordinationId: string) {
  return store.audit
    .recent({ limit: 500 })
    .filter((a) => a.coordinationId === coordinationId)
    .reverse()
    .map((a) => JSON.parse(a.payloadJson ?? "{}") as Record<string, unknown>);
}

describe("plan validation", () => {
  it("accepts the canonical plan and round-trips an authored plan", () => {
    expect(() => validatePlan(canonicalPlan())).not.toThrow();
    expect(parsePlan(canonicalPlan()).decider).toBe("decider");
  });
  it("rejects malformed plans", () => {
    expect(() => parsePlan({ participants: [], decider: "x" })).toThrow();
    // decider label present but wrong role, and no implementer
    expect(() =>
      validatePlan({ participants: [{ label: "a", role: "reviewer", client: "codex" }], decider: "a", maxIterations: 3 }),
    ).toThrow(/role 'decider'/);
    // unknown decider label
    expect(() => validatePlan({ ...canonicalPlan(), decider: "ghost" })).toThrow(/not among/);
  });
});

describe("coordination FSM", () => {
  it("lands on a first-round accept (Claude implements / Codex reviews / Claude decides)", async () => {
    const { runner, run, store } = harness([true]);
    const r = await run();
    expect(r.accepted).toBe(true);
    expect(r.landed).toBe(true);
    expect(r.iterations).toBe(1);
    expect(runner.landed).toBe(1);
    expect(store.coordination.get(r.coordinationId)!.phase).toBe("done");
  });

  it("loops on reject, feeds the critique forward, then lands on accept", async () => {
    const { runner, run } = harness([false, true]);
    const r = await run();
    expect(r.iterations).toBe(2);
    expect(r.accepted).toBe(true);
    expect(runner.landed).toBe(1);
    expect(runner.implementCalls[0]!.priorCritique).toBeUndefined();
    expect(runner.implementCalls[1]!.priorCritique).toBe("needs work");
  });

  it("converges at the iteration limit WITHOUT landing when never accepted", async () => {
    const { runner, run } = harness([false, false], 2);
    const r = await run();
    expect(r.accepted).toBe(false);
    expect(r.landed).toBe(false);
    expect(r.iterations).toBe(2);
    // Decider-only landing: a stream of rejects never lands (reviewer is advisory).
    expect(runner.landed).toBe(0);
  });

  it("re-plans (bounded + logged) when the loop converges without landing, then stops", async () => {
    const store = memoryStore();
    const commandAuditId = store.audit.append({ type: "command", source: "signal:+1" });
    const runner = new MockRunner([false, false]); // never accept
    const ex = new CoordinationExecutor(store, runner, log);
    const plan = { ...canonicalPlan(1), maxReplans: 1 }; // 1 iteration per cycle, 1 re-plan allowed
    const r = await ex.run({ commandAuditId, task: "x", workingDir: "/w", plan, coordinationId: "rp1" });

    expect(r.accepted).toBe(false);
    expect(r.iterations).toBe(2); // 1 initial round + 1 after the single re-plan
    const events = eventsFor(store, "rp1");
    expect(events.some((e) => e.event === "phase" && e.phase === "replanning")).toBe(true);
    const replans = store.audit.recent({ limit: 500 }).filter((a) => a.type === "replan");
    expect(replans).toHaveLength(1);
  });

  it("records phase progression and artifact-handoff provenance", async () => {
    const { store, run } = harness([false, true]);
    const r = await run();
    const events = eventsFor(store, r.coordinationId);
    const phases = events.filter((e) => e.event === "phase").map((e) => e.phase);
    expect(phases).toContain("implementing");
    expect(phases).toContain("reviewing");
    expect(phases).toContain("deciding");
    expect(phases).toContain("revising");
    expect(phases.at(-1)).toBe("done");

    const handoffs = events.filter((e) => e.event === "handoff");
    expect(handoffs.some((h) => h.kind === "diff" && h.from === "implementer" && h.to === "reviewer")).toBe(true);
    expect(handoffs.some((h) => h.kind === "critique" && h.to === "decider")).toBe(true);

    const decisions = events.filter((e) => e.event === "decision");
    expect(decisions).toHaveLength(2);
    expect(decisions.at(-1)!.accept).toBe(true);
  });
});
