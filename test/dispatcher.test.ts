import { describe, it, expect, vi } from "vitest";

import { memoryStore } from "../src/state/db.js";
import { createLogger } from "../src/core/logger.js";
import { MockSignalTransport, SignalControlPlane } from "../src/control/signal.js";
import { ApprovalNotifier, parseApprovalReply } from "../src/control/approval-notifier.js";
import { Dispatcher } from "../src/dispatcher/dispatcher.js";
import type { Coordinator } from "../src/coordination/coordinator.js";
import type { ResolvedConfig } from "../src/config/index.js";
import type { SessionRow } from "../src/state/types.js";

const log = createLogger("error");
const cfg = { repos: { sip: "/repos/sip" } } as unknown as ResolvedConfig;

function harness() {
  const store = memoryStore();
  const transport = new MockSignalTransport();
  const signal = new SignalControlPlane(transport, { account: "+1acct", allowlist: ["+1me"] }, store, log);
  const notifier = new ApprovalNotifier(store, signal, log);
  return { store, transport, signal, notifier };
}

describe("parseApprovalReply", () => {
  it("recognizes pure y/n replies, with optional short id", () => {
    expect(parseApprovalReply("y")).toEqual({ approve: true, session: false });
    expect(parseApprovalReply("Yes")).toEqual({ approve: true, session: false });
    expect(parseApprovalReply("n")).toEqual({ approve: false, session: false });
    expect(parseApprovalReply("deny a1b2c3d4")).toEqual({ approve: false, session: false, idPrefix: "a1b2c3d4" });
  });
  it("recognizes the approve-for-session forms (`ya` / `always`)", () => {
    expect(parseApprovalReply("ya")).toEqual({ approve: true, session: true });
    expect(parseApprovalReply("always")).toEqual({ approve: true, session: true });
    expect(parseApprovalReply("ya 341f082d")).toEqual({ approve: true, session: true, idPrefix: "341f082d" });
    // session is approve-only: there is no "deny for session".
    expect(parseApprovalReply("n")!.session).toBe(false);
  });
  it("rejects anything that isn't a pure reply (so commands pass through)", () => {
    expect(parseApprovalReply("no longer needed, build X")).toBeNull();
    expect(parseApprovalReply("launch a session")).toBeNull();
    expect(parseApprovalReply("yesterday")).toBeNull();
    expect(parseApprovalReply("yesterday's plan")).toBeNull();
    expect(parseApprovalReply("yard work")).toBeNull();
  });

  it("tolerates surrounding quotes/punctuation a phone keyboard adds (the `y 341f082d'` prod bug)", () => {
    expect(parseApprovalReply("y 341f082d'")).toEqual({ approve: true, session: false, idPrefix: "341f082d" });
    expect(parseApprovalReply("'y 341f082d'")).toEqual({ approve: true, session: false, idPrefix: "341f082d" });
    expect(parseApprovalReply("n 8fc872f5'")).toEqual({ approve: false, session: false, idPrefix: "8fc872f5" });
    expect(parseApprovalReply("y.")).toEqual({ approve: true, session: false });
  });
});

describe("ApprovalNotifier round-trip over (mock) Signal", () => {
  it("pushes a prompt for a pending approval, then applies a y reply", async () => {
    const { store, transport, notifier } = harness();
    store.sessions.create({ id: "s1", client: "claude", mode: "deliverable", workingDir: "/w" });
    store.approvals.create({ id: "abcd1234ef", sessionId: "s1", toolName: "Bash", request: { command: "rm x" } });

    await notifier.tick();
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]!.recipient).toBe("+1me");
    expect(transport.sent[0]!.text).toContain("Bash");
    expect(transport.sent[0]!.text).toContain("abcd1234");

    const handled = await notifier.handleReply("y");
    expect(handled).toBe(true);
    expect(store.approvals.get("abcd1234ef")!.status).toBe("approved");
    expect(store.approvals.get("abcd1234ef")!.decidedVia).toBe("signal");
  });

  it("does not re-announce an already-notified approval", async () => {
    const { store, transport, notifier } = harness();
    store.sessions.create({ id: "s1", client: "claude", mode: "deliverable", workingDir: "/w" });
    store.approvals.create({ id: "dup1", sessionId: "s1", toolName: "Bash", request: {} });
    await notifier.tick();
    await notifier.tick();
    expect(transport.sent).toHaveLength(1);
  });
});

describe("Dispatcher", () => {
  it("applies an approval reply and does NOT spawn", async () => {
    const { store, signal, notifier } = harness();
    store.sessions.create({ id: "s1", client: "claude", mode: "deliverable", workingDir: "/w" });
    store.approvals.create({ id: "p1", sessionId: "s1", toolName: "Bash", request: {} });
    const spawn = vi.fn();
    const d = new Dispatcher({ sessions: { spawn, attachCommand: () => "" }, signal, notifier, cfg, log });

    await d.handle({ source: "+1me", text: "n", timestamp: 0 });
    expect(spawn).not.toHaveBeenCalled();
    expect(store.approvals.get("p1")!.status).toBe("denied");
  });

  it("classifies a command and spawns the right session", async () => {
    const { transport, signal, notifier } = harness();
    const row: SessionRow = {
      id: "newid123", client: "codex", mode: "interactive", role: "solo", workingDir: "/repos/sip",
      tmuxTarget: "sw-newid123", status: "running", coordinationId: null, egressAllowlist: null,
      summary: null, createdAt: 0, updatedAt: 0, endedAt: null,
    };
    const spawn = vi.fn(async () => row);
    const d = new Dispatcher({ sessions: { spawn, attachCommand: (id) => `attach ${id}` }, signal, notifier, cfg, log });

    await d.handle({ source: "+1me", text: "launch a codex session in sip so I can make changes", timestamp: 0 });
    expect(spawn).toHaveBeenCalledOnce();
    const req = spawn.mock.calls[0]![0];
    expect(req).toMatchObject({ client: "codex", mode: "interactive", repo: "sip" });
    expect(transport.sent.at(-1)!.text).toContain("spawned newid123");
  });

  it("does not crash when spawn returns a sandboxed IronCurtain session (no attachable pane)", async () => {
    const { transport, signal, notifier } = harness();
    const icRow = {
      id: "icsess01", client: "claude", mode: "interactive", role: "solo", workingDir: "/repos/sip",
      tmuxTarget: null, status: "running", coordinationId: null, egressAllowlist: null,
      summary: null, backend: "ironcurtain", claudeSessionId: null, externalSessionId: null,
      backendHandle: '{"label":1}', createdAt: 0, updatedAt: 0, endedAt: null,
    } as SessionRow;
    const spawn = vi.fn(async () => icRow);
    // Real attachCommand THROWS not_attachable for ironcurtain sessions — the guard must avoid calling it.
    const attachCommand = vi.fn(() => { throw new Error("not_attachable"); });
    const d = new Dispatcher({ sessions: { spawn, attachCommand }, signal, notifier, cfg, log });

    await d.handle({ source: "+1me", text: "launch a codex session in sip so I can make changes", timestamp: 0 });

    expect(spawn).toHaveBeenCalledOnce();
    expect(attachCommand).not.toHaveBeenCalled(); // guarded — would have thrown
    const last = transport.sent.at(-1)!.text;
    expect(last).toContain("spawned icsess01");
    expect(last).toContain("Sandboxed tab");
    expect(last).not.toContain("couldn't start");
  });

  it("routes a coordinated command to the coordinator, not a single spawn", async () => {
    const { store, signal, notifier } = harness();
    const spawn = vi.fn();
    const run = vi.fn(async () => ({ coordinationId: "co1", accepted: true, landed: true, iterations: 1, finalDiff: "", decisionReasoning: "ok" }));
    const coordinator = { run } as unknown as Coordinator;
    const d = new Dispatcher({ sessions: { spawn, attachCommand: () => "" }, signal, notifier, cfg, log, store, coordinator });
    await d.handle({ source: "+1me", text: "coordinate code and review between Claude Code and Codex, with Claude deciding", timestamp: 0 });
    expect(spawn).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]![0]).toMatchObject({ task: expect.stringContaining("coordinate") });
  });
});

describe("Dispatcher — session-targeted steering relay (§5.5)", () => {
  it("relays @<id> to a live streaming session's inbox, before approval-reply, and does not spawn or decide", async () => {
    const { store, signal, notifier } = harness();
    store.sessions.create({ id: "strm01", client: "claude", mode: "interactive", workingDir: "/w", status: "running", backend: "claude_sdk_stream" });
    // A pending approval proves a steering 'yes' is NOT consumed as an approval reply.
    store.approvals.create({ id: "appr0001", sessionId: "strm01", toolName: "Bash", request: {} });
    const spawn = vi.fn();
    const d = new Dispatcher({ sessions: { spawn, attachCommand: () => "" }, signal, notifier, cfg, log, store });

    await d.handle({ source: "+1me", text: "@strm01 yes do the thing", timestamp: 0 });

    expect(spawn).not.toHaveBeenCalled();
    expect(store.approvals.get("appr0001")!.status).toBe("pending"); // steering did not resolve it
    const queued = store.steering.listQueued("strm01");
    expect(queued).toHaveLength(1);
    expect(queued[0]!.body).toBe("yes do the thing"); // @id stripped
    expect(queued[0]!.source).toBe("signal");
    expect(queued[0]!.sender).toBe("+1me");
    expect(store.audit.recent().some((a) => a.type === "steering_message")).toBe(true);
  });

  it("refuses to steer a non-streaming session and enqueues nothing", async () => {
    const { store, transport, signal, notifier } = harness();
    store.sessions.create({ id: "dlv01", client: "claude", mode: "deliverable", workingDir: "/w", status: "running", backend: "claude_sdk" });
    const spawn = vi.fn();
    const d = new Dispatcher({ sessions: { spawn, attachCommand: () => "" }, signal, notifier, cfg, log, store });
    await d.handle({ source: "+1me", text: "@dlv01 hello", timestamp: 0 });
    expect(store.steering.listQueued("dlv01")).toHaveLength(0);
    expect(transport.sent.at(-1)!.text).toContain("not a steerable streaming session");
  });

  it("reports an unknown @<id> target instead of spawning", async () => {
    const { store, transport, signal, notifier } = harness();
    const spawn = vi.fn();
    const d = new Dispatcher({ sessions: { spawn, attachCommand: () => "" }, signal, notifier, cfg, log, store });
    await d.handle({ source: "+1me", text: "@nope hello there", timestamp: 0 });
    expect(spawn).not.toHaveBeenCalled();
    expect(transport.sent.at(-1)!.text).toContain("no live session");
  });

  it("sheds steering load when the session's queue is saturated (backpressure nack)", async () => {
    const { store, transport, signal, notifier } = harness();
    store.sessions.create({ id: "strm9", client: "claude", mode: "interactive", workingDir: "/w", status: "running", backend: "claude_sdk_stream" });
    for (let i = 0; i < 200; i++) store.steering.enqueue({ sessionId: "strm9", source: "signal", body: `m${i}` });
    const spawn = vi.fn();
    const d = new Dispatcher({ sessions: { spawn, attachCommand: () => "" }, signal, notifier, cfg, log, store });
    await d.handle({ source: "+1me", text: "@strm9 one more", timestamp: 0 });
    expect(store.steering.countQueued("strm9")).toBe(200); // the new turn was NOT enqueued
    expect(transport.sent.at(-1)!.text).toContain("queue full");
  });
});

describe("Dispatcher — Signal reply (quote) continues a session instead of spawning", () => {
  function quoteHarness() {
    const h = harness();
    h.store.sessions.create({ id: "last-vd3", client: "claude", mode: "interactive", workingDir: "/w", status: "running", backend: "claude_sdk_stream" });
    const spawn = vi.fn();
    const d = new Dispatcher({ sessions: { spawn, attachCommand: () => "" }, signal: h.signal, notifier: h.notifier, cfg, log, store: h.store });
    return { ...h, spawn, d };
  }

  it("routes a reply to a result digest into that session's inbox (no @id, no new session)", async () => {
    const { store, spawn, d } = quoteHarness();
    // The user swipe-replies to the digest "💬 last-vd3:\n<result>" with a plain follow-up.
    await d.handle({ source: "+1me", text: "also check the archived folder", timestamp: 0, quotedText: "💬 last-vd3:\nI've reviewed your inbox directly…" });
    expect(spawn).not.toHaveBeenCalled();
    const queued = store.steering.listQueued("last-vd3");
    expect(queued).toHaveLength(1);
    expect(queued[0]!.body).toBe("also check the archived folder");
  });

  it("routes a reply to a status digest too (▶️ <id>: running)", async () => {
    const { store, spawn, d } = quoteHarness();
    await d.handle({ source: "+1me", text: "stop after this step", timestamp: 0, quotedText: "▶️ last-vd3: running" });
    expect(spawn).not.toHaveBeenCalled();
    expect(store.steering.listQueued("last-vd3")).toHaveLength(1);
  });

  it("a plain message with NO quote still spawns (native-reply-only contract)", async () => {
    const { spawn, d } = quoteHarness();
    await d.handle({ source: "+1me", text: "build a new thing", timestamp: 0 });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("a reply whose quote names no known session falls through to spawn", async () => {
    const { spawn, d } = quoteHarness();
    await d.handle({ source: "+1me", text: "do it", timestamp: 0, quotedText: "💬 ghost-zzz:\nsomething" });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("reports (does not spawn) when the replied-to session has ended", async () => {
    const { store, transport, spawn, d } = quoteHarness();
    store.sessions.setStatus("last-vd3", "done");
    await d.handle({ source: "+1me", text: "keep going", timestamp: 0, quotedText: "💬 last-vd3:\ndone" });
    expect(spawn).not.toHaveBeenCalled();
    expect(store.steering.listQueued("last-vd3")).toHaveLength(0);
    expect(transport.sent.at(-1)!.text).toContain("has ended");
  });

  it("a y reply to an approval PROMPT decides the approval, it does not steer", async () => {
    const { store, d } = quoteHarness();
    store.approvals.create({ id: "appr5678ab", sessionId: "last-vd3", toolName: "Bash", request: { command: "ls" } });
    await d.handle({ source: "+1me", text: "y", timestamp: 0, quotedText: "🔐 Session last-vd3 wants Bash" });
    expect(store.approvals.get("appr5678ab")!.status).toBe("approved");
    expect(store.steering.listQueued("last-vd3")).toHaveLength(0); // not steered
  });
});

describe("Dispatcher — convert (cli) command", () => {
  it("routes 'cli <id>' to convertToNative (local) and reports the ungated handoff", async () => {
    const { signal, notifier, transport } = harness();
    const convertToNative = vi.fn(async () => ({ id: "strm1" }) as SessionRow);
    const d = new Dispatcher({ sessions: { spawn: vi.fn(), attachCommand: () => "mosh host", convertToNative }, signal, notifier, cfg, log });
    await d.handle({ source: "+1me", text: "cli strm1", timestamp: 0 });
    expect(convertToNative).toHaveBeenCalledWith("strm1", { remoteControl: false });
    expect(transport.sent.at(-1)!.text.toLowerCase()).toContain("full cli");
    expect(transport.sent.at(-1)!.text.toLowerCase()).toContain("ungated");
  });

  it("routes 'cli <id> phone' (and 'convert <id> rc') to the remote-control target", async () => {
    const { signal, notifier } = harness();
    const convertToNative = vi.fn(async () => ({ id: "strm1" }) as SessionRow);
    const d = new Dispatcher({ sessions: { spawn: vi.fn(), attachCommand: () => "", convertToNative }, signal, notifier, cfg, log });
    await d.handle({ source: "+1me", text: "cli strm1 phone", timestamp: 0 });
    expect(convertToNative).toHaveBeenLastCalledWith("strm1", { remoteControl: true });
    await d.handle({ source: "+1me", text: "convert strm1 rc", timestamp: 0 });
    expect(convertToNative).toHaveBeenLastCalledWith("strm1", { remoteControl: true });
  });

  it("reports the error and does not spawn when convert fails", async () => {
    const { signal, notifier, transport } = harness();
    const spawn = vi.fn();
    const convertToNative = vi.fn(async () => { throw new Error("not a gated streaming session"); });
    const d = new Dispatcher({ sessions: { spawn, attachCommand: () => "", convertToNative }, signal, notifier, cfg, log });
    await d.handle({ source: "+1me", text: "cli strm1", timestamp: 0 });
    expect(spawn).not.toHaveBeenCalled();
    expect(transport.sent.at(-1)!.text).toContain("couldn't convert");
  });

  it("does not mistake a normal spawn command for a convert", async () => {
    const { signal, notifier } = harness();
    const spawn = vi.fn(async () => ({ id: "x", client: "claude", mode: "interactive", workingDir: "/w" }) as SessionRow);
    const convertToNative = vi.fn();
    const d = new Dispatcher({ sessions: { spawn, attachCommand: () => "", convertToNative }, signal, notifier, cfg, log });
    await d.handle({ source: "+1me", text: "build a CLI tool for parsing logs", timestamp: 0 });
    expect(convertToNative).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});

describe("Dispatcher — resume command", () => {
  it("routes 'resume <id>' to sessions.resume, not a spawn", async () => {
    const { signal, notifier } = harness();
    const resume = vi.fn(async () => ({ id: "r1" }) as SessionRow);
    const spawn = vi.fn();
    const d = new Dispatcher({ sessions: { spawn, attachCommand: () => "attach r1", resume }, signal, notifier, cfg, log });
    await d.handle({ source: "+1me", text: "resume r1", timestamp: 0 });
    expect(resume).toHaveBeenCalledWith("r1");
    expect(spawn).not.toHaveBeenCalled();
  });
});
