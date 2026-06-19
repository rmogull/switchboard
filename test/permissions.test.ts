import { describe, it, expect, vi } from "vitest";

import { memoryStore } from "../src/state/db.js";
import { PermissionPolicy } from "../src/permissions/policy.js";
import { ApprovalGateway } from "../src/permissions/approvals.js";
import { createCanUseTool, type CanUseTool } from "../src/permissions/hook.js";
import { buildGatedSdkOptions } from "../src/permissions/session-options.js";
import type { ApprovalRow } from "../src/state/types.js";

function setup(opts: { timeoutMs?: number; onRequest?: (a: ApprovalRow) => void } = {}) {
  const store = memoryStore();
  store.sessions.create({ id: "s1", client: "claude", mode: "deliverable", workingDir: "/work/proj" });
  const policy = new PermissionPolicy();
  const gateway = new ApprovalGateway(store, {
    timeoutMs: opts.timeoutMs ?? 1000,
    pollMs: 15,
    ...(opts.onRequest ? { onRequest: opts.onRequest } : {}),
  });
  const hook = createCanUseTool({
    sessionId: "s1",
    policy,
    ctx: { workingDir: "/work/proj", egressAllowlist: [] },
    gateway,
    store,
  });
  return { store, hook };
}

describe("canUseTool hook", () => {
  it("allows policy-allowed tools with no approval round-trip", async () => {
    const { store, hook } = setup();
    const r = await hook("Write", { file_path: "/work/proj/a.ts", content: "x" });
    expect(r.behavior).toBe("allow");
    expect(store.approvals.listPending()).toHaveLength(0);
    expect(store.audit.recent().some((a) => a.type === "tool_use")).toBe(true);
  });

  it("routes an ask to approval and honors approve (simulated Signal reply)", async () => {
    const { store, hook } = setup({
      onRequest: (a) => setTimeout(() => store.approvals.decide(a.id, "approved", "signal"), 25),
    });
    const r = await hook("Bash", { command: "curl https://evil.com" });
    expect(r.behavior).toBe("allow");
    expect(store.audit.recent().some((a) => a.type === "approval_decision")).toBe(true);
  });

  it("routes an ask to approval and honors deny", async () => {
    const { store, hook } = setup({
      onRequest: (a) => setTimeout(() => store.approvals.decide(a.id, "denied", "signal"), 25),
    });
    const r = await hook("Write", { file_path: "/etc/passwd", content: "x" });
    expect(r.behavior).toBe("deny");
  });

  it("fails closed (deny) when an approval times out", async () => {
    const { store, hook } = setup({ timeoutMs: 80 }); // no decider → timeout
    const r = await hook("Bash", { command: "rm -rf /" });
    expect(r.behavior).toBe("deny");
    if (r.behavior === "deny") expect(r.message).toContain("timeout");
    expect(store.approvals.listPending()).toHaveLength(0); // resolved to timeout
  });

  it("honors a decision that wins the row at the timeout boundary, not a spurious deny (BUG A)", async () => {
    const store = memoryStore();
    store.sessions.create({ id: "s1", client: "claude", mode: "deliverable", workingDir: "/work/proj" });
    const gateway = new ApprovalGateway(store, { timeoutMs: 5, pollMs: 40 });
    // Simulate the TOCTOU race: when the gateway's own timeout decide() runs, the
    // row has just been approved out-of-band (Signal), so our timeout write loses.
    const realDecide = store.approvals.decide.bind(store.approvals);
    vi.spyOn(store.approvals, "decide").mockImplementation((id, status, via) => {
      if (status === "timeout") {
        realDecide(id, "approved", "signal"); // a real approval won the row first
        return false; // ...so our timeout UPDATE matches nothing
      }
      return realDecide(id, status, via);
    });
    const outcome = await gateway.requestDecision({ sessionId: "s1", toolName: "Bash", request: {} });
    expect(outcome.status).toBe("approved");
    expect(outcome.approved).toBe(true);
    expect(outcome.via).toBe("signal");
  });

  it("releases a parked approval as denied when the SDK turn is interrupted (AbortSignal)", async () => {
    const store = memoryStore();
    store.sessions.create({ id: "s1", client: "claude", mode: "interactive", workingDir: "/work/proj" });
    const gateway = new ApprovalGateway(store, { timeoutMs: 5000, pollMs: 20 });
    const ac = new AbortController();
    const p = gateway.requestDecision({ sessionId: "s1", toolName: "Bash", request: {}, signal: ac.signal });
    setTimeout(() => ac.abort(), 15); // operator /interrupt before any decision
    const outcome = await p;
    expect(outcome.approved).toBe(false);
    expect(outcome.status).toBe("denied"); // not "timeout" — released promptly, not after 5s
    expect(store.approvals.listPending()).toHaveLength(0);
  });

  it("marks the session awaiting_approval while blocked, then running", async () => {
    let statusDuring = "";
    const { store, hook } = setup({
      onRequest: (a) => {
        statusDuring = store.sessions.get("s1")!.status;
        setTimeout(() => store.approvals.decide(a.id, "approved", "dashboard"), 20);
      },
    });
    await hook("Bash", { command: "rm x" });
    expect(statusDuring).toBe("awaiting_approval");
    expect(store.sessions.get("s1")!.status).toBe("running");
  });
});

describe("canUseTool hook — approve-for-session + concurrent dedup (repeated-prompt fix)", () => {
  const MCP = "mcp__claude_ai_Gmail__search_threads"; // mcp__* → unknown → ask

  it("auto-allows the SAME tool for the rest of the session after approve-for-session", async () => {
    let requests = 0;
    const { store, hook } = setup({
      onRequest: (a) => {
        requests++;
        setTimeout(() => store.approvals.decide(a.id, "approved", "signal", "session"), 10);
      },
    });
    expect((await hook(MCP, { q: "from:a" })).behavior).toBe("allow");
    // a later call to the same tool (even with DIFFERENT args) is auto-allowed, no new ask
    expect((await hook(MCP, { q: "from:b" })).behavior).toBe("allow");
    expect(requests).toBe(1);
    expect(
      store.audit
        .recent()
        .some((a) => a.type === "approval_decision" && JSON.parse(a.payloadJson!).via === "session_grant"),
    ).toBe(true);
  });

  it("approve (once) does NOT grant — a later identical call re-asks", async () => {
    let requests = 0;
    const { store, hook } = setup({
      onRequest: (a) => {
        requests++;
        setTimeout(() => store.approvals.decide(a.id, "approved", "signal"), 10);
      },
    });
    await hook(MCP, { q: "x" });
    await hook(MCP, { q: "x" });
    expect(requests).toBe(2);
  });

  it("collapses CONCURRENT identical asks onto one approval (the same-second double prompt)", async () => {
    let requests = 0;
    const { store, hook } = setup({
      onRequest: (a) => {
        requests++;
        setTimeout(() => store.approvals.decide(a.id, "approved", "signal"), 25);
      },
    });
    const tool = "mcp__claude_ai_ms365__outlook_email_search";
    const [r1, r2] = await Promise.all([hook(tool, { folder: "inbox" }), hook(tool, { folder: "inbox" })]);
    expect(r1.behavior).toBe("allow");
    expect(r2.behavior).toBe("allow");
    expect(requests).toBe(1); // both shared ONE round-trip
    expect(store.audit.recent().filter((a) => a.type === "approval_request").length).toBe(1);
  });

  it("does NOT collapse concurrent asks with different inputs", async () => {
    let requests = 0;
    const { store, hook } = setup({
      onRequest: (a) => {
        requests++;
        setTimeout(() => store.approvals.decide(a.id, "approved", "signal"), 25);
      },
    });
    const tool = "mcp__claude_ai_ms365__outlook_email_search";
    await Promise.all([hook(tool, { folder: "inbox" }), hook(tool, { folder: "sent" })]);
    expect(requests).toBe(2);
  });
});

describe("gated SDK options (policy-authoritative isolation)", () => {
  const noop: CanUseTool = async () => ({ behavior: "deny", message: "x" });

  it("ALWAYS sets settingSources to [] so ambient ~/.claude settings can't bypass canUseTool", () => {
    const o = buildGatedSdkOptions({ cwd: "/w", canUseTool: noop });
    // This is a security guard: a regression here silently disables the policy.
    expect(o.settingSources).toEqual([]);
    expect(o.permissionMode).toBe("default");
    expect(o.cwd).toBe("/w");
  });

  it("passes through optional tool filters only when provided", () => {
    const a = buildGatedSdkOptions({ cwd: "/w", canUseTool: noop });
    expect("allowedTools" in a).toBe(false);
    const b = buildGatedSdkOptions({ cwd: "/w", canUseTool: noop, disallowedTools: ["AskUserQuestion"] });
    expect(b.disallowedTools).toEqual(["AskUserQuestion"]);
  });
});
