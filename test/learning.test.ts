import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { memoryStore } from "../src/state/db.js";
import { detectCandidates } from "../src/learning/suggestions.js";
import { LearnedRulesStore } from "../src/learning/rules.js";
import { LearningService } from "../src/learning/service.js";
import { PermissionPolicy } from "../src/permissions/policy.js";

function seedApprovals(store: ReturnType<typeof memoryStore>) {
  store.sessions.create({ id: "s1", client: "claude", mode: "deliverable", workingDir: "/w" });
  // 5 approved writes to the same Drive folder → a candidate.
  for (let i = 0; i < 5; i++) {
    const id = `w${i}`;
    store.approvals.create({ id, sessionId: "s1", toolName: "Write", request: { action: "write_outside_workdir", path: `/Drive/Presentations/f${i}.pptx` } });
    store.approvals.decide(id, "approved", "signal");
  }
  // 3 approved egress to api.x.com → below threshold, not yet a candidate.
  for (let i = 0; i < 3; i++) {
    const id = `e${i}`;
    store.approvals.create({ id, sessionId: "s1", toolName: "WebFetch", request: { action: "network_egress", hosts: ["api.x.com"] } });
    store.approvals.decide(id, "approved", "signal");
  }
}

describe("suggestion detection", () => {
  it("surfaces a recurring approved write as a candidate, ignoring sub-threshold groups", () => {
    const store = memoryStore();
    seedApprovals(store);
    const candidates = detectCandidates(store, [], 5);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ kind: "write", scope: "/Drive/Presentations", count: 5 });
  });

  it("excludes a group already covered by a learned rule", () => {
    const store = memoryStore();
    seedApprovals(store);
    const existing = [{ id: "r1", kind: "write" as const, scope: "/Drive/Presentations", reason: "x", sourceApprovalIds: [], createdAt: 0 }];
    expect(detectCandidates(store, existing, 5)).toHaveLength(0);
  });
});

describe("LearningService.promote + policy honoring (no silent drift)", () => {
  it("promotes a candidate to a learned rule with audited provenance, then the policy auto-allows it", () => {
    const home = mkdtempSync(join(tmpdir(), "sw-learn-"));
    const store = memoryStore();
    seedApprovals(store);
    const rulesStore = new LearnedRulesStore(home);
    const svc = new LearningService(store, rulesStore, 5);

    const candidate = svc.candidates()[0]!;
    const rule = svc.promote(candidate.id, "operator");
    expect(rule.kind).toBe("write");
    expect(rule.scope).toBe("/Drive/Presentations");
    expect(rule.sourceApprovalIds).toHaveLength(5);

    // Audited as a memory_promotion (auto_allow), and no longer a candidate.
    expect(store.audit.recent().some((a) => a.type === "memory_promotion")).toBe(true);
    expect(svc.candidates().find((c) => c.id === candidate.id)).toBeUndefined();

    // The policy now auto-allows writes under that folder — but ONLY that target.
    const policy = new PermissionPolicy({}, [], rulesStore.load());
    const ctx = { workingDir: "/w", egressAllowlist: [] };
    const allowed = policy.evaluate("Write", { file_path: "/Drive/Presentations/new.pptx" }, ctx);
    expect(allowed.decision).toBe("allow");
    expect(allowed.detail.learnedRule).toBe(rule.id);
    // A different outside-workdir write still asks.
    expect(policy.evaluate("Write", { file_path: "/etc/elsewhere.txt" }, ctx).decision).toBe("ask");
  });

  it("rejects promoting an unknown candidate id", () => {
    const home = mkdtempSync(join(tmpdir(), "sw-learn-"));
    const store = memoryStore();
    const svc = new LearningService(store, new LearnedRulesStore(home), 5);
    expect(() => svc.promote("deadbeef", "operator")).toThrow(/unknown_candidate|no auto-allow/);
  });
});
