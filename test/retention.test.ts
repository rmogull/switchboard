import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Store } from "../src/state/db.js";
import { createLogger } from "../src/core/logger.js";
import { RetentionService } from "../src/dispatcher/retention.js";

const log = createLogger("error");
const DAY = 86_400_000;

function setup() {
  const clock = { ms: 0 };
  const store = new Store(":memory:", { now: () => clock.ms });
  const stateDir = mkdtempSync(join(tmpdir(), "sw-ret-"));
  const setNow = (ms: number) => { clock.ms = ms; };
  return { store, stateDir, setNow };
}

function mkScratch(stateDir: string, id: string): { scratch: string; sess: string } {
  const scratch = join(stateDir, "scratch", id);
  const sess = join(stateDir, "sessions", id);
  mkdirSync(scratch, { recursive: true });
  writeFileSync(join(scratch, "f.txt"), "x");
  mkdirSync(sess, { recursive: true });
  writeFileSync(join(sess, "task.md"), "do it");
  return { scratch, sess };
}

describe("RetentionService.sweep", () => {
  it("purges an OLD terminal session (rows + children + dirs) and PRESERVES the audit_log", () => {
    const { store, stateDir, setNow } = setup();
    // An old, done session at t=0 with full child state.
    store.sessions.create({ id: "old1", client: "claude", mode: "interactive", workingDir: "/repo", tmuxTarget: "sw-old1", status: "running", backend: "claude_sdk_stream" });
    store.audit.append({ type: "spawn", source: "dispatcher", sessionId: "old1", payload: { x: 1 } });
    store.approvals.create({ id: "oa1", sessionId: "old1", toolName: "Bash", request: {} });
    store.steering.enqueue({ sessionId: "old1", source: "signal", body: "hi" });
    store.outbound.enqueue({ sessionId: "old1", kind: "result", body: "done" });
    store.transcript.append({ sessionId: "old1", kind: "assistant", source: "model", text: "hello" });
    store.sessions.setStatus("old1", "done"); // ended_at = 0
    const dirs = mkScratch(stateDir, "old1");

    // 40 days later, retain 30 days → old1 is stale.
    setNow(40 * DAY);
    const purged = new RetentionService(store, { sessionDays: 30, stateDir, now: () => 40 * DAY }, log).sweep();

    expect(purged).toBe(1);
    expect(store.sessions.get("old1")).toBeUndefined();
    expect(store.approvals.get("oa1")).toBeUndefined();
    expect(store.steering.listQueued("old1")).toHaveLength(0);
    expect(store.transcript.listRecent("old1", 10)).toHaveLength(0);
    expect(existsSync(dirs.scratch)).toBe(false);
    expect(existsSync(dirs.sess)).toBe(false);
    // The append-only audit_log is intact: the original spawn row SURVIVES, and the
    // purge itself is recorded (the security-audit guarantee).
    const auditForOld = store.audit.recent({ sessionId: "old1" });
    expect(auditForOld.some((a) => a.type === "spawn")).toBe(true);
    expect(auditForOld.some((a) => a.payloadJson?.includes("retention_purge"))).toBe(true);
  });

  it("keeps RECENT terminal sessions and ACTIVE sessions", () => {
    const { store, setNow, stateDir } = setup();
    setNow(40 * DAY);
    store.sessions.create({ id: "recent", client: "claude", mode: "interactive", workingDir: "/w", status: "running" });
    store.sessions.setStatus("recent", "done"); // ended_at = 40*DAY (1 day ago at sweep)
    store.sessions.create({ id: "active", client: "claude", mode: "interactive", workingDir: "/w", status: "running" });

    const purged = new RetentionService(store, { sessionDays: 30, stateDir, now: () => 41 * DAY }, log).sweep();

    expect(purged).toBe(0);
    expect(store.sessions.get("recent")).toBeTruthy();
    expect(store.sessions.get("active")).toBeTruthy();
  });

  it("is a no-op when retention is disabled (sessionDays = 0)", () => {
    const { store, stateDir } = setup();
    store.sessions.create({ id: "old2", client: "claude", mode: "interactive", workingDir: "/w", status: "running" });
    store.sessions.setStatus("old2", "killed"); // ended_at = 0, very old
    const purged = new RetentionService(store, { sessionDays: 0, stateDir, now: () => 9999 * DAY }, log).sweep();
    expect(purged).toBe(0);
    expect(store.sessions.get("old2")).toBeTruthy();
  });

  it("restores the transcript append-only guard after a purge (immutability intact for survivors)", () => {
    const { store, stateDir, setNow } = setup();
    store.sessions.create({ id: "gone", client: "claude", mode: "interactive", workingDir: "/w", status: "running" });
    store.transcript.append({ sessionId: "gone", kind: "assistant", source: "model", text: "a" });
    store.sessions.setStatus("gone", "done"); // ended_at = 0
    setNow(40 * DAY);
    // A surviving recent session with a transcript row.
    store.sessions.create({ id: "live", client: "claude", mode: "interactive", workingDir: "/w", status: "running" });
    store.transcript.append({ sessionId: "live", kind: "assistant", source: "model", text: "keep" });

    new RetentionService(store, { sessionDays: 30, stateDir, now: () => 40 * DAY }, log).sweep();

    // The trigger must be back: a direct DELETE of a survivor's transcript still ABORTS.
    expect(() => store.db.prepare("DELETE FROM transcript WHERE session_id = 'live'").run()).toThrow(/append-only/);
    expect(store.transcript.listRecent("live", 10)).toHaveLength(1);
  });
});
