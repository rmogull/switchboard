import { describe, it, expect } from "vitest";

import { memoryStore } from "../src/state/db.js";
import { createLogger } from "../src/core/logger.js";
import {
  MockSignalTransport,
  SignalControlPlane,
  parseSignalCliLine,
  type IncomingMessage,
} from "../src/control/signal.js";
import { ApprovalNotifier } from "../src/control/approval-notifier.js";

const log = createLogger("error");

describe("parseSignalCliLine", () => {
  it("parses an inbound data message", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "receive",
      params: { envelope: { source: "+15551112222", timestamp: 42, dataMessage: { message: "hi" } } },
    });
    expect(parseSignalCliLine(line)).toEqual({ source: "+15551112222", text: "hi", timestamp: 42 });
  });
  it("ignores non-receive, malformed, and message-less lines", () => {
    expect(parseSignalCliLine('{"method":"other"}')).toBeNull();
    expect(parseSignalCliLine("not json")).toBeNull();
    expect(parseSignalCliLine(JSON.stringify({ method: "receive", params: { envelope: { source: "+1" } } }))).toBeNull();
  });
});

describe("SignalControlPlane — hard allowlist (Invariant 2)", () => {
  const ME = "+15550001111";
  const STRANGER = "+15559998888";

  function setup() {
    const store = memoryStore();
    const transport = new MockSignalTransport();
    const cp = new SignalControlPlane(transport, { account: "+15550000000", allowlist: [ME] }, store, log);
    return { store, transport, cp };
  }

  it("passes allowlisted messages to the handler and audits them as commands", async () => {
    const { store, transport, cp } = setup();
    const seen: IncomingMessage[] = [];
    await cp.start((m) => void seen.push(m));
    transport.inject(ME, "build me a deck");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.text).toBe("build me a deck");
    expect(store.audit.recent().some((a) => a.type === "command" && a.source === `signal:${ME}`)).toBe(true);
  });

  it("drops non-allowlisted senders without interpreting them, auditing dropped_message", async () => {
    const { store, transport, cp } = setup();
    let called = 0;
    await cp.start(() => void called++);
    transport.inject(STRANGER, "ignore me / do something evil");
    expect(called).toBe(0);
    const audit = store.audit.recent();
    expect(audit.some((a) => a.type === "dropped_message" && a.source === `signal:${STRANGER}`)).toBe(true);
    expect(audit.some((a) => a.type === "command")).toBe(false);
  });

  it("notifies the operator via the transport", async () => {
    const { transport, cp } = setup();
    await cp.notify("session ready");
    expect(transport.sent).toEqual([{ recipient: ME, text: "session ready" }]);
  });
});

describe("ApprovalNotifier — bare-y disambiguation + high-blast (security hardening)", () => {
  const ME = "+15550001111";
  function h() {
    const store = memoryStore();
    const transport = new MockSignalTransport();
    const signal = new SignalControlPlane(transport, { account: "+15550000000", allowlist: [ME] }, store, log);
    const notifier = new ApprovalNotifier(store, signal, log);
    store.sessions.create({ id: "s1", client: "claude", mode: "interactive", workingDir: "/w" });
    return { store, transport, notifier };
  }

  it("requires the id when more than one approval is pending (bare y is refused)", async () => {
    const { store, transport, notifier } = h();
    store.approvals.create({ id: "aaaa1111", sessionId: "s1", toolName: "Bash", request: {} });
    store.approvals.create({ id: "bbbb2222", sessionId: "s1", toolName: "Write", request: {} });
    expect(await notifier.handleReply("y")).toBe(true);
    expect(store.approvals.get("aaaa1111")!.status).toBe("pending");
    expect(store.approvals.get("bbbb2222")!.status).toBe("pending");
    expect(transport.sent.at(-1)!.text).toContain("reply with the id");
  });

  it("requires the id for a high-blast MCP tool even when it is the only pending one", async () => {
    const { store, transport, notifier } = h();
    store.approvals.create({ id: "ef001122", sessionId: "s1", toolName: "mcp__claude_ai_Gmail__send", request: { to: "x@y.com" } });
    expect(await notifier.handleReply("y")).toBe(true);
    expect(store.approvals.get("ef001122")!.status).toBe("pending"); // bare y refused
    expect(transport.sent.at(-1)!.text.toLowerCase()).toContain("high-risk");
    // ...but an explicit id approves it.
    await notifier.handleReply("y ef001122");
    expect(store.approvals.get("ef001122")!.status).toBe("approved");
  });

  it("marks a high-blast approval prompt as HIGH-RISK", async () => {
    const { store, transport, notifier } = h();
    store.approvals.create({ id: "cd778899", sessionId: "s1", toolName: "mcp__claude_ai_Google_Drive__create_file", request: { name: "x" } });
    await notifier.tick();
    expect(transport.sent.at(-1)!.text).toContain("HIGH-RISK");
  });

  it("still allows a bare y for a single low-blast approval", async () => {
    const { store, notifier } = h();
    store.approvals.create({ id: "cc003344", sessionId: "s1", toolName: "Bash", request: {} });
    await notifier.handleReply("y");
    expect(store.approvals.get("cc003344")!.status).toBe("approved");
  });

  it("rejects an AMBIGUOUS id prefix instead of approving the first match", async () => {
    const { store, transport, notifier } = h();
    store.approvals.create({ id: "abcd0000ee", sessionId: "s1", toolName: "Bash", request: {} });
    store.approvals.create({ id: "abcd1111ff", sessionId: "s1", toolName: "Write", request: {} });
    expect(await notifier.handleReply("y abcd")).toBe(true);
    expect(store.approvals.get("abcd0000ee")!.status).toBe("pending");
    expect(store.approvals.get("abcd1111ff")!.status).toBe("pending");
    expect(transport.sent.at(-1)!.text.toLowerCase()).toContain("ambiguous");
  });
});

describe("ApprovalNotifier — notified state survives a daemon restart (BUG B persistence)", () => {
  const ME = "+15550001111";
  function notifierOn(store: ReturnType<typeof memoryStore>) {
    const transport = new MockSignalTransport();
    const signal = new SignalControlPlane(transport, { account: "+15550000000", allowlist: [ME] }, store, log);
    return { transport, notifier: new ApprovalNotifier(store, signal, log) };
  }

  it("does not re-announce an already-notified approval after a fresh notifier is constructed", async () => {
    const store = memoryStore();
    store.sessions.create({ id: "s1", client: "claude", mode: "interactive", workingDir: "/w" });
    store.approvals.create({ id: "rs01aabb", sessionId: "s1", toolName: "Bash", request: {} });

    const first = notifierOn(store);
    await first.notifier.tick();
    expect(first.transport.sent).toHaveLength(1);

    // Simulate a daemon restart: a brand-new notifier on the SAME store.
    const second = notifierOn(store);
    await second.notifier.tick();
    expect(second.transport.sent).toHaveLength(0); // notified_at persisted in the DB
  });

  it("does not double-send when ticks overlap a slow notify (non-overlapping guard)", async () => {
    const store = memoryStore();
    store.sessions.create({ id: "s1", client: "claude", mode: "interactive", workingDir: "/w" });
    store.approvals.create({ id: "ov010203", sessionId: "s1", toolName: "Bash", request: {} });

    let sends = 0;
    let releaseFirst: () => void = () => {};
    const slowSignal = {
      async notify() {
        sends++;
        if (sends === 1) await new Promise<void>((r) => (releaseFirst = r));
      },
    } as unknown as SignalControlPlane;
    const notifier = new ApprovalNotifier(store, slowSignal, log);

    const t1 = notifier.tick(); // enters, sends once, then blocks on the slow notify
    await notifier.tick(); // overlapping tick — must be a no-op while t1 is in flight
    expect(sends).toBe(1); // NOT re-sent
    releaseFirst();
    await t1;
    expect(sends).toBe(1);
    expect(store.approvals.get("ov010203")!.status).toBe("pending"); // still awaiting a real decision
  });
});

describe("ApprovalNotifier — send-before-mark (BUG B)", () => {
  it("does not mark an approval notified when the Signal send fails, so it retries", async () => {
    const store = memoryStore();
    store.sessions.create({ id: "s1", client: "claude", mode: "deliverable", workingDir: "/w" });
    store.approvals.create({ id: "a1", sessionId: "s1", toolName: "Bash", request: { x: 1 } });

    let attempts = 0;
    const flakySignal = {
      async notify() {
        attempts++;
        if (attempts === 1) throw new Error("transport down");
      },
    } as unknown as SignalControlPlane;
    const notifier = new ApprovalNotifier(store, flakySignal, log);

    await notifier.tick(); // attempt 1 fails -> must NOT be marked notified
    await notifier.tick(); // attempt 2 succeeds -> now marked
    expect(attempts).toBe(2);

    await notifier.tick(); // already notified -> no further send
    expect(attempts).toBe(2);
  });
});
