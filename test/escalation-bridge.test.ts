import { describe, it, expect, beforeEach } from "vitest";

import { memoryStore, type Store } from "../src/state/db.js";
import { createLogger } from "../src/core/logger.js";
import { EscalationBridge } from "../src/control/escalation-bridge.js";
import type { IcEscalationDto, IcDecision } from "../src/execution/ironcurtain/client.js";
import type { IcRpcResult } from "../src/execution/ironcurtain/ws-client.js";
import type { IronCurtainDaemon } from "../src/execution/ironcurtain/daemon.js";
import type { IronCurtainClient } from "../src/execution/ironcurtain/client.js";

const log = createLogger("error");

/** A controllable stand-in for the connected IronCurtainClient. */
class MockClient {
  escalations: IcEscalationDto[] = [];
  resolved: Array<{ escId: string; decision: IcDecision }> = [];
  resolveResult: IcRpcResult = { ok: true, payload: {} };
  endedFn: ((label: number) => void) | undefined;
  closeFn: ((reason: string) => void) | undefined;

  onEscalation(): () => void {
    return () => {};
  }
  onSessionEnded(fn: (label: number) => void): () => void {
    this.endedFn = fn;
    return () => {
      this.endedFn = undefined;
    };
  }
  onClose(fn: (reason: string) => void): () => void {
    this.closeFn = fn;
    return () => {
      this.closeFn = undefined;
    };
  }
  async listEscalations(): Promise<IcEscalationDto[]> {
    return this.escalations;
  }
  async resolve(escalationId: string, decision: IcDecision): Promise<IcRpcResult> {
    this.resolved.push({ escId: escalationId, decision });
    return this.resolveResult;
  }
}

function makeDaemon(client: MockClient | undefined): {
  ic: IronCurtainDaemon;
  setClient: (c: MockClient | undefined) => void;
} {
  let current = client;
  const ic = {
    get client() {
      return current as unknown as IronCurtainClient | undefined;
    },
    adopt: async () => current as unknown as IronCurtainClient | undefined,
  } as unknown as IronCurtainDaemon;
  return { ic, setClient: (c) => (current = c) };
}

function esc(over: Partial<IcEscalationDto> = {}): IcEscalationDto {
  return {
    escalationId: "e1",
    sessionLabel: 3,
    serverName: "filesystem",
    toolName: "write_file",
    arguments: { path: "/etc/x" },
    reason: "write outside the workspace",
    ...over,
  };
}

/** A real sandboxed session row whose label the bridge can attribute approvals to. */
function seedIcSession(store: Store, id: string, label: number): void {
  store.sessions.create({ id, client: "claude", mode: "deliverable", workingDir: "/w", status: "running", backend: "ironcurtain" });
  store.sessions.setIronCurtainHandle(id, label);
}

describe("EscalationBridge", () => {
  let store: Store;
  beforeEach(() => {
    store = memoryStore();
  });

  // pollMs is huge so the internal timer never fires — every test drives tick() by hand.
  const newBridge = (ic: IronCurtainDaemon) => new EscalationBridge(store, ic, log, 1_000_000_000);

  it("ingests an escalation into a high-blast approval attributed to the real session", async () => {
    seedIcSession(store, "audit-x9k", 3);
    const client = new MockClient();
    client.escalations = [esc()];
    const bridge = newBridge(makeDaemon(client).ic);
    await bridge.tick();

    const pending = store.approvals.listPending();
    expect(pending).toHaveLength(1);
    const a = pending[0]!;
    expect(a.sessionId).toBe("audit-x9k"); // attributed to the real row, no synthetic
    expect(a.toolName.startsWith("mcp__")).toBe(true); // forced high-blast
    const req = JSON.parse(a.requestJson);
    expect(req.source).toBe("ironcurtain");
    expect(req.escalationId).toBe("e1");
    expect(req.tool).toBe("write_file");
  });

  it("auto-creates a synthetic FK session when no real row owns the label", async () => {
    const client = new MockClient();
    client.escalations = [esc({ sessionLabel: 7 })];
    const bridge = newBridge(makeDaemon(client).ic);
    await bridge.tick();

    const a = store.approvals.listPending()[0]!;
    expect(a.sessionId).toBe("ic-s7");
    expect(store.sessions.get("ic-s7")?.backend).toBe("ironcurtain");
  });

  it("relays an approved decision back to IronCurtain exactly once", async () => {
    seedIcSession(store, "s", 3);
    const client = new MockClient();
    client.escalations = [esc()];
    const bridge = newBridge(makeDaemon(client).ic);
    await bridge.tick();
    const a = store.approvals.listPending()[0]!;

    store.approvals.decide(a.id, "approved", "signal");
    client.escalations = []; // IC has cleared it
    await bridge.tick();
    expect(client.resolved).toEqual([{ escId: "e1", decision: "approved" }]);

    // A second tick must NOT re-resolve (it left the track).
    await bridge.tick();
    expect(client.resolved).toHaveLength(1);
  });

  it("relays denied and timeout decisions both as 'denied'", async () => {
    seedIcSession(store, "s1", 1);
    seedIcSession(store, "s2", 2);
    const client = new MockClient();
    client.escalations = [esc({ escalationId: "d1", sessionLabel: 1 }), esc({ escalationId: "t1", sessionLabel: 2 })];
    const bridge = newBridge(makeDaemon(client).ic);
    await bridge.tick();

    const byEsc = (e: string) => store.approvals.listPending().find((a) => JSON.parse(a.requestJson).escalationId === e)!;
    store.approvals.decide(byEsc("d1").id, "denied", "signal");
    store.approvals.decide(byEsc("t1").id, "timeout", "policy_auto");
    client.escalations = [];
    await bridge.tick();

    expect(client.resolved.sort((a, b) => a.escId.localeCompare(b.escId))).toEqual([
      { escId: "d1", decision: "denied" },
      { escId: "t1", decision: "denied" },
    ]);
  });

  it("fail-closes a tracked escalation when its session ends (and tells IC denied)", async () => {
    seedIcSession(store, "s", 3);
    const client = new MockClient();
    client.escalations = [esc()];
    const bridge = newBridge(makeDaemon(client).ic);
    await bridge.tick(); // ingest + wire onSessionEnded

    const a = store.approvals.listPending()[0]!;
    expect(a.status).toBe("pending");
    client.endedFn!(3); // session 3 ended

    const after = store.approvals.get(a.id)!;
    expect(after.status).toBe("timeout");
    expect(after.decidedVia).toBe("policy_auto");
    expect(client.resolved).toEqual([{ escId: "e1", decision: "denied" }]);

    // No double-resolve on the next poll.
    client.escalations = [];
    await bridge.tick();
    expect(client.resolved).toHaveLength(1);
  });

  it("fail-closes ALL pending escalations on an involuntary WS close", async () => {
    seedIcSession(store, "s1", 1);
    seedIcSession(store, "s2", 2);
    const client = new MockClient();
    client.escalations = [esc({ escalationId: "e1", sessionLabel: 1 }), esc({ escalationId: "e2", sessionLabel: 2 })];
    const bridge = newBridge(makeDaemon(client).ic);
    await bridge.tick();
    expect(store.approvals.listPending()).toHaveLength(2);

    client.closeFn!("connection lost");
    expect(store.approvals.listPending()).toHaveLength(0);
    // onClose has no client to relay to — fail-close is local-only.
    expect(client.resolved).toHaveLength(0);
  });

  it("fail-closes when the daemon is unreachable on a poll", async () => {
    seedIcSession(store, "s", 3);
    const client = new MockClient();
    client.escalations = [esc()];
    const { ic, setClient } = makeDaemon(client);
    const bridge = newBridge(ic);
    await bridge.tick();
    const a = store.approvals.listPending()[0]!;

    setClient(undefined); // daemon went away; adopt() will also return undefined
    await bridge.tick();
    expect(store.approvals.get(a.id)!.status).toBe("timeout");
  });

  it("dedupes a redelivered escalation into a single approval", async () => {
    seedIcSession(store, "s", 3);
    const client = new MockClient();
    client.escalations = [esc()];
    const bridge = newBridge(makeDaemon(client).ic);
    await bridge.tick();
    await bridge.tick(); // same escalation still listed
    expect(store.approvals.listPending()).toHaveLength(1);
  });

  it("rehydrates the return path from persisted approval rows after a restart", async () => {
    // Simulate a pre-restart pending IronCurtain approval row.
    seedIcSession(store, "s", 5);
    store.approvals.create({
      id: "appr-old",
      sessionId: "s",
      toolName: "mcp__ironcurtain__filesystem__write_file",
      request: { source: "ironcurtain", escalationId: "e9", sessionLabel: 5 },
    });

    const client = new MockClient();
    const bridge = newBridge(makeDaemon(client).ic);
    bridge.start(); // runs rehydrate
    bridge.stop(); // clear the timer; we drive tick() manually

    store.approvals.decide("appr-old", "approved", "dashboard");
    await bridge.tick();
    expect(client.resolved).toEqual([{ escId: "e9", decision: "approved" }]);
  });

  it("swallows a benign ESCALATION_NOT_FOUND on resolve", async () => {
    seedIcSession(store, "s", 3);
    const client = new MockClient();
    client.escalations = [esc()];
    client.resolveResult = { ok: false, code: "ESCALATION_NOT_FOUND", message: "gone" };
    const bridge = newBridge(makeDaemon(client).ic);
    await bridge.tick();
    const a = store.approvals.listPending()[0]!;
    store.approvals.decide(a.id, "approved", "signal");
    client.escalations = [];
    await expect(bridge.tick()).resolves.toBeUndefined(); // no throw
    expect(client.resolved).toHaveLength(1);
  });

  describe("IronCurtainBridge read/decide surface", () => {
    it("lists sessions + escalations and decides through approvals.decide", async () => {
      seedIcSession(store, "audit-x9k", 3);
      const client = new MockClient();
      client.escalations = [esc()];
      const bridge = newBridge(makeDaemon(client).ic);
      await bridge.tick();

      expect(bridge.enabled()).toBe(true);
      const sessions = bridge.listSessions();
      expect(sessions.map((s) => s.id)).toContain("audit-x9k");
      expect(sessions.find((s) => s.id === "audit-x9k")!.escalationsPending).toBe(1);

      const escs = bridge.listEscalations();
      expect(escs).toHaveLength(1);
      const approvalId = escs[0]!.approvalId;

      const r = bridge.decideEscalation(approvalId, "approved");
      expect(r.ok).toBe(true);
      expect(store.approvals.get(approvalId)!.status).toBe("approved");

      // A second decide loses the race (resolve-exactly-once).
      expect(bridge.decideEscalation(approvalId, "denied").ok).toBe(false);
    });

    it("rejects a decide on a non-ironcurtain approval", async () => {
      store.sessions.create({ id: "native", client: "claude", mode: "deliverable", workingDir: "/w", status: "running" });
      store.approvals.create({ id: "native-appr", sessionId: "native", toolName: "Bash", request: { command: "ls" } });
      const bridge = newBridge(makeDaemon(new MockClient()).ic);
      expect(bridge.decideEscalation("native-appr", "approved").ok).toBe(false);
    });
  });
});
