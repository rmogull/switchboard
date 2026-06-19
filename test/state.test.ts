import { describe, it, expect } from "vitest";

import { memoryStore } from "../src/state/db.js";
import { fixedClock } from "../src/core/clock.js";

describe("audit log — append-only (Invariant 6)", () => {
  it("appends events and round-trips the payload", () => {
    const store = memoryStore();
    const id = store.audit.append({
      type: "command",
      source: "signal:+15551234567",
      payload: { text: "build the deck" },
    });
    expect(id).toBeGreaterThan(0);
    const row = store.audit.get(id)!;
    expect(row.type).toBe("command");
    expect(JSON.parse(row.payloadJson!)).toEqual({ text: "build the deck" });
  });

  it("rejects UPDATE and DELETE at the storage layer", () => {
    const store = memoryStore();
    const id = store.audit.append({ type: "spawn", source: "dispatcher" });
    expect(() =>
      store.db.prepare("UPDATE audit_log SET type = 'x' WHERE id = ?").run(id),
    ).toThrow(/append-only/);
    expect(() =>
      store.db.prepare("DELETE FROM audit_log WHERE id = ?").run(id),
    ).toThrow(/append-only/);
    // The row is still intact and unchanged.
    expect(store.audit.get(id)!.type).toBe("spawn");
  });
});

describe("sessions", () => {
  it("stamps ended_at only on terminal transitions", () => {
    const clock = fixedClock(1000);
    const store = memoryStore(clock);
    const s = store.sessions.create({
      id: "abc12345",
      client: "claude",
      mode: "deliverable",
      workingDir: "/tmp/x",
    });
    expect(s.status).toBe("starting");
    expect(s.endedAt).toBeNull();

    clock.advance(50);
    store.sessions.setStatus("abc12345", "running");
    expect(store.sessions.get("abc12345")!.endedAt).toBeNull();

    clock.advance(50);
    store.sessions.setStatus("abc12345", "done");
    const done = store.sessions.get("abc12345")!;
    expect(done.status).toBe("done");
    expect(done.endedAt).toBe(1100);
  });

  it("round-trips the egress allowlist as JSON", () => {
    const store = memoryStore();
    store.sessions.create({
      id: "egress01",
      client: "codex",
      mode: "coordinated",
      workingDir: "/tmp/y",
      egressAllowlist: ["example.com", "api.test"],
    });
    expect(store.sessions.get("egress01")!.egressAllowlist).toEqual([
      "example.com",
      "api.test",
    ]);
  });

  it("lists only active sessions when asked", () => {
    const store = memoryStore();
    store.sessions.create({ id: "act1", client: "claude", mode: "interactive", workingDir: "/a" });
    store.sessions.create({ id: "act2", client: "claude", mode: "deliverable", workingDir: "/b" });
    store.sessions.setStatus("act2", "done");
    const active = store.sessions.list({ active: true });
    expect(active.map((s) => s.id)).toEqual(["act1"]);
  });
});

describe("approvals — single decision wins the race (§5.5)", () => {
  it("decides once; a concurrent second decision loses", () => {
    const store = memoryStore();
    store.sessions.create({ id: "s1", client: "claude", mode: "deliverable", workingDir: "/tmp/z" });
    store.approvals.create({
      id: "ap1",
      sessionId: "s1",
      toolName: "Bash",
      request: { cmd: "write /Drive/Presentations/x.pptx" },
    });
    // Signal reply and dashboard click race; exactly one transitions the row.
    expect(store.approvals.decide("ap1", "approved", "signal")).toBe(true);
    expect(store.approvals.decide("ap1", "denied", "dashboard")).toBe(false);
    const row = store.approvals.get("ap1")!;
    expect(row.status).toBe("approved");
    expect(row.decidedVia).toBe("signal");
  });
});

describe("memory proposals — propose then promote (Invariant 5)", () => {
  it("resolves a pending proposal exactly once", () => {
    const store = memoryStore();
    store.sessions.create({ id: "s2", client: "claude", mode: "deliverable", workingDir: "/tmp/w" });
    store.proposals.create({
      id: "p1",
      sessionId: "s2",
      category: "feedback",
      proposedText: "prefers two-space indentation",
    });
    expect(store.proposals.listPending()).toHaveLength(1);
    expect(store.proposals.resolve("p1", "promoted")).toBe(true);
    expect(store.proposals.resolve("p1", "rejected")).toBe(false);
    expect(store.proposals.listPending()).toHaveLength(0);
  });
});

describe("coordination plans", () => {
  it("tracks phase and decider against an originating command", () => {
    const store = memoryStore();
    const cmdId = store.audit.append({ type: "command", source: "signal:+1" });
    store.coordination.create({
      id: "co1",
      commandAuditId: cmdId,
      topology: { participants: [], decider: "decider" },
    });
    store.coordination.setPhase("co1", "implementing");
    store.coordination.setDecider("co1", "sessABCD");
    const plan = store.coordination.get("co1")!;
    expect(plan.phase).toBe("implementing");
    expect(plan.deciderSessionId).toBe("sessABCD");
    expect(plan.commandAuditId).toBe(cmdId);
  });
});
