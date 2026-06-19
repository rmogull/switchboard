import { describe, it, expect } from "vitest";

import { memoryStore } from "../src/state/db.js";

function store() {
  const s = memoryStore();
  s.sessions.create({ id: "s1", client: "claude", mode: "interactive", workingDir: "/w" });
  return s;
}

describe("SteeringRepo — inbound relay ordering + idempotent consume", () => {
  it("drains queued rows in insertion order (the SDK input order)", () => {
    const s = store();
    s.steering.enqueue({ sessionId: "s1", source: "signal", sender: "+1", body: "first" });
    s.steering.enqueue({ sessionId: "s1", source: "pane", body: "second" });
    const queued = s.steering.listQueued("s1");
    expect(queued.map((r) => r.body)).toEqual(["first", "second"]);
    expect(queued[0]!.id).toBeLessThan(queued[1]!.id);
  });

  it("consumes a row exactly once", () => {
    const s = store();
    const row = s.steering.enqueue({ sessionId: "s1", source: "signal", body: "hi" });
    expect(s.steering.consume(row.id)).toBe(true);
    expect(s.steering.consume(row.id)).toBe(false); // already consumed
    expect(s.steering.listQueued("s1")).toHaveLength(0);
  });

  it("scopes queued rows per session", () => {
    const s = store();
    s.sessions.create({ id: "s2", client: "claude", mode: "interactive", workingDir: "/w" });
    s.steering.enqueue({ sessionId: "s1", source: "signal", body: "for s1" });
    s.steering.enqueue({ sessionId: "s2", source: "signal", body: "for s2" });
    expect(s.steering.listQueued("s1").map((r) => r.body)).toEqual(["for s1"]);
    expect(s.steering.listQueued("s2").map((r) => r.body)).toEqual(["for s2"]);
  });
});

describe("OutboundRepo — digest queue + send-before-mark", () => {
  it("queues digests and marks each sent exactly once", () => {
    const s = store();
    s.outbound.enqueue({ sessionId: "s1", kind: "status", body: "running" });
    const r2 = s.outbound.enqueue({ sessionId: "s1", kind: "result", body: "done: ok" });
    expect(s.outbound.listQueued().map((r) => r.body)).toEqual(["running", "done: ok"]);
    expect(s.outbound.markSent(r2.id)).toBe(true);
    expect(s.outbound.markSent(r2.id)).toBe(false);
    expect(s.outbound.listQueued().map((r) => r.body)).toEqual(["running"]);
  });
});

describe("schema migration — backend column is additive", () => {
  it("defaults backend/claudeSessionId to null and round-trips a set backend", () => {
    const s = store();
    expect(s.sessions.get("s1")!.backend).toBeNull();
    expect(s.sessions.get("s1")!.claudeSessionId).toBeNull();
    s.sessions.create({ id: "s3", client: "claude", mode: "interactive", workingDir: "/w", backend: "claude_sdk_stream" });
    expect(s.sessions.get("s3")!.backend).toBe("claude_sdk_stream");
    s.sessions.setClaudeSessionId("s3", "sdk-abc");
    expect(s.sessions.get("s3")!.claudeSessionId).toBe("sdk-abc");
  });
});
