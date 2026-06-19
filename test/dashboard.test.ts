import { describe, it, expect, afterEach } from "vitest";

import { memoryStore } from "../src/state/db.js";
import { createLogger } from "../src/core/logger.js";
import { Tmux } from "../src/execution/tmux.js";
import { SessionManager } from "../src/execution/session.js";
import { DashboardServer } from "../src/control/dashboard.js";
import { DASHBOARD_HTML } from "../src/control/dashboard-html.js";
import type { ResolvedConfig } from "../src/config/index.js";
import type { IronCurtainBridge, IcSessionView, IcEscalationView, IcSessionDigest, DecideResult } from "../src/control/ironcurtain-bridge.js";
import type { IcDecision } from "../src/execution/ironcurtain/client.js";

const log = createLogger("error");
// Tmux pointed at an unused socket: listSessions() returns [] (no server), which
// is fine — we exercise the API surface, not live panes.
const tmux = new Tmux({ socket: "switchboard-dash-test" });
const cfg = {
  tmux: { sessionPrefix: "sw" },
  dashboard: { enabled: true, port: 0, bindAddress: "127.0.0.1" },
} as unknown as ResolvedConfig;

let server: DashboardServer | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
});

describe("DashboardServer frontend", () => {
  it("serves syntactically valid JS — guards against template-literal escape bugs (e.g. a \\n inside an embedded quoted string)", () => {
    const scripts = [...DASHBOARD_HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    expect(scripts.length).toBeGreaterThan(0);
    // new Function PARSES the body without executing it (so browser globals like
    // document/fetch are irrelevant) — it throws ONLY on a SyntaxError, exactly the
    // failure a real newline inside a single-quoted string produces. This would have
    // caught the convert() confirm regression that broke the whole dashboard script.
    for (const m of scripts) {
      expect(() => new Function(m[1]!)).not.toThrow();
    }
  });
});

describe("DashboardServer API", () => {
  it("serves state and decides approvals", async () => {
    const store = memoryStore();
    store.sessions.create({ id: "dsh1", client: "claude", mode: "deliverable", workingDir: "/w", status: "done" });
    store.approvals.create({ id: "apx", sessionId: "dsh1", toolName: "Bash", request: { command: "rm x" } });

    const sessions = new SessionManager(store, tmux, cfg, log);
    server = new DashboardServer({ store, sessions, tmux, cfg, log });
    const { port } = await server.start();
    const base = `http://127.0.0.1:${port}`;

    const state = await (await fetch(`${base}/api/state`)).json();
    expect(state.sessions.map((s: { id: string }) => s.id)).toContain("dsh1");
    expect(state.approvals).toHaveLength(1);
    expect(state.approvals[0].toolName).toBe("Bash");

    const decide = await fetch(`${base}/api/approvals/apx/decide`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approved" }),
    });
    expect(decide.status).toBe(200);
    expect(store.approvals.get("apx")!.status).toBe("approved");
    expect(store.approvals.get("apx")!.decidedVia).toBe("dashboard");
    // The decision audit must correlate to the originating session (Invariant 6).
    const auditRow = store.audit.recent().find((a) => a.type === "approval_decision" && a.source === "dashboard");
    expect(auditRow?.sessionId).toBe("dsh1");

    const after = await (await fetch(`${base}/api/state`)).json();
    expect(after.approvals).toHaveLength(0);

    // index page renders
    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain("<title>Switchboard</title>");

    // unknown route → 404
    expect((await fetch(`${base}/api/nope`)).status).toBe(404);
  });

  it("returns 409 (not 500) for a direct attach call on a sandboxed IronCurtain session", async () => {
    const store = memoryStore();
    store.sessions.create({ id: "icx1", client: "claude", mode: "deliverable", workingDir: "/w", status: "running", backend: "ironcurtain" });
    const sessions = new SessionManager(store, tmux, cfg, log);
    server = new DashboardServer({ store, sessions, tmux, cfg, log });
    const { port } = await server.start();
    const r = await fetch(`http://127.0.0.1:${port}/api/sessions/icx1/attach`);
    expect(r.status).toBe(409);
    expect(String((await r.json()).error)).toMatch(/sandbox/i);
  });

  it("rejects (does not hang) when the port is already in use", async () => {
    const store = memoryStore();
    const sessions = new SessionManager(store, tmux, cfg, log);
    server = new DashboardServer({ store, sessions, tmux, cfg, log });
    const { port } = await server.start();
    const cfg2 = { ...cfg, dashboard: { enabled: true, port, bindAddress: "127.0.0.1" } } as unknown as ResolvedConfig;
    const conflicting = new DashboardServer({ store, sessions, tmux, cfg: cfg2, log });
    await expect(conflicting.start()).rejects.toThrow();
    await conflicting.stop();
  });

  it("serves the durable transcript for an SDK-backed session and renders it as the log", async () => {
    const store = memoryStore();
    store.sessions.create({ id: "trx1", client: "claude", mode: "interactive", workingDir: "/w", status: "running", backend: "claude_sdk_stream" });
    store.transcript.append({ sessionId: "trx1", kind: "user", source: "signal", text: "do X" });
    store.transcript.append({ sessionId: "trx1", kind: "assistant", source: "model", text: "doing X" });

    const sessions = new SessionManager(store, tmux, cfg, log);
    server = new DashboardServer({ store, sessions, tmux, cfg, log });
    const { port } = await server.start();
    const base = `http://127.0.0.1:${port}`;

    const tr = await (await fetch(`${base}/api/sessions/trx1/transcript?after=0`)).json();
    expect(tr.rows.map((r: { text: string }) => r.text)).toEqual(["do X", "doing X"]);
    expect(tr.cursor).toBe(tr.rows[1].seq);

    // Incremental poll past the cursor returns nothing new.
    const tr2 = await (await fetch(`${base}/api/sessions/trx1/transcript?after=${tr.cursor}`)).json();
    expect(tr2.rows).toHaveLength(0);

    // /log renders the transcript (not capturePane) for an SDK-backed session.
    const lg = await (await fetch(`${base}/api/sessions/trx1/log`)).json();
    expect(lg.log).toContain("doing X");
    expect(lg.log).toContain("[claude]");
  });

  it("rejects an invalid approval decision", async () => {
    const store = memoryStore();
    store.sessions.create({ id: "dsh2", client: "claude", mode: "deliverable", workingDir: "/w", status: "done" });
    store.approvals.create({ id: "apy", sessionId: "dsh2", toolName: "Bash", request: {} });
    const sessions = new SessionManager(store, tmux, cfg, log);
    server = new DashboardServer({ store, sessions, tmux, cfg, log });
    const { port } = await server.start();
    const r = await fetch(`http://127.0.0.1:${port}/api/approvals/apy/decide`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "maybe" }),
    });
    expect(r.status).toBe(400);
    expect(store.approvals.get("apy")!.status).toBe("pending");
  });

  it("re-issues /remote-control into a live native console pane and audits it", async () => {
    const store = memoryStore();
    store.sessions.create({ id: "rc1", client: "claude", mode: "interactive", workingDir: "/w", status: "running", backend: "claude_cli_console", tmuxTarget: "sw-rc1" });
    const sent: Array<{ name: string; keys: string }> = [];
    const fakeTmux = { sendKeys: async (name: string, keys: string) => { sent.push({ name, keys }); }, listSessions: async () => [] } as unknown as Tmux;
    const sessions = new SessionManager(store, fakeTmux, cfg, log);
    server = new DashboardServer({ store, sessions, tmux: fakeTmux, cfg, log });
    const { port } = await server.start();

    const r = await fetch(`http://127.0.0.1:${port}/api/sessions/rc1/remote-control`, { method: "POST" });
    expect(r.status).toBe(200);
    expect(sent).toEqual([{ name: "sw-rc1", keys: "/remote-control" }]);
    const audit = store.audit.recent().find((a) => a.type === "status_change" && a.source === "dashboard" && a.sessionId === "rc1");
    expect(JSON.parse(audit!.payloadJson!).event).toBe("remote_control_reconnect");
  });

  it("refuses remote-control on a gated (non-console) session — never injects keystrokes into a gated pane", async () => {
    const store = memoryStore();
    store.sessions.create({ id: "rc2", client: "claude", mode: "interactive", workingDir: "/w", status: "running", backend: "claude_sdk_stream", tmuxTarget: "sw-rc2" });
    const sent: unknown[] = [];
    const fakeTmux = { sendKeys: async (name: string, keys: string) => { sent.push({ name, keys }); }, listSessions: async () => [] } as unknown as Tmux;
    const sessions = new SessionManager(store, fakeTmux, cfg, log);
    server = new DashboardServer({ store, sessions, tmux: fakeTmux, cfg, log });
    const { port } = await server.start();

    const r = await fetch(`http://127.0.0.1:${port}/api/sessions/rc2/remote-control`, { method: "POST" });
    expect(r.status).toBe(409);
    expect(sent).toHaveLength(0);
  });

  it("surfaces coordinations with their phase, decider, and participant sessions", async () => {
    const store = memoryStore();
    const auditId = store.audit.append({ type: "command", source: "signal:+1" });
    store.coordination.create({
      id: "cv1", commandAuditId: auditId, phase: "implementing",
      topology: { participants: [{ label: "impl", role: "implementer", client: "claude" }], decider: "impl" },
    });
    store.sessions.create({ id: "coord-impl-1", client: "claude", mode: "coordinated", role: "implementer", workingDir: "/w", status: "running", coordinationId: "cv1", backend: "claude_sdk" });
    store.coordination.setDecider("cv1", "coord-impl-1");
    const sessions = new SessionManager(store, tmux, cfg, log);
    server = new DashboardServer({ store, sessions, tmux, cfg, log });
    const { port } = await server.start();

    const state = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
    expect(state.coordinations).toHaveLength(1);
    expect(state.coordinations[0].phase).toBe("implementing");
    expect(state.coordinations[0].decider).toBe("coord-impl-1");
    expect(state.coordinations[0].participants.map((p: { id: string }) => p.id)).toContain("coord-impl-1");
  });

  it("refuses remote-control on a terminal (not-live) session even via a direct POST", async () => {
    const store = memoryStore();
    store.sessions.create({ id: "rc3", client: "claude", mode: "interactive", workingDir: "/w", status: "done", backend: "claude_cli_console", tmuxTarget: "sw-rc3" });
    const sent: unknown[] = [];
    const fakeTmux = { sendKeys: async (name: string, keys: string) => { sent.push({ name, keys }); }, listSessions: async () => [] } as unknown as Tmux;
    const sessions = new SessionManager(store, fakeTmux, cfg, log);
    server = new DashboardServer({ store, sessions, tmux: fakeTmux, cfg, log });
    const { port } = await server.start();

    const r = await fetch(`http://127.0.0.1:${port}/api/sessions/rc3/remote-control`, { method: "POST" });
    expect(r.status).toBe(409);
    expect(sent).toHaveLength(0);
  });

  it("converts a gated streaming session to native CLI via POST /convert (and flips the backend)", async () => {
    const store = memoryStore();
    store.sessions.create({ id: "cvd1", client: "claude", mode: "interactive", workingDir: "/work/proj", status: "running", backend: "claude_sdk_stream", tmuxTarget: "sw-cvd1" });
    store.sessions.setClaudeSessionId("cvd1", "654a6192-ef68-4059-9936-35436702f859");
    const respawns: { command: string }[] = [];
    const fakeTmux = {
      listSessions: async () => ["sw-cvd1"],
      respawnPane: async (_t: string, command: string) => { respawns.push({ command }); },
    } as unknown as Tmux;
    const convCfg = { ...cfg, clients: { claude: { enabled: true, cliPath: "claude" }, codex: { enabled: true } } } as unknown as ResolvedConfig;
    const sessions = new SessionManager(store, fakeTmux, convCfg, log);
    server = new DashboardServer({ store, sessions, tmux: fakeTmux, cfg, log });
    const { port } = await server.start();

    const r = await fetch(`http://127.0.0.1:${port}/api/sessions/cvd1/convert`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: "remote_control" }),
    });
    expect(r.status).toBe(200);
    expect(store.sessions.get("cvd1")!.backend).toBe("claude_cli_console");
    expect(respawns[0]!.command).toContain("--remote-control");
    expect(respawns[0]!.command).toContain("--resume");
    // The gated→native posture change is audited (Invariant 6).
    expect(store.audit.recent().some((a) => a.payloadJson?.includes("convert_to_native"))).toBe(true);
  });

  it("isolates sandboxed sessions/escalations from the native tab and serves the Sandboxed routes", async () => {
    const store = memoryStore();
    // A native session + approval, and a sandboxed (ironcurtain) session + bridged approval.
    store.sessions.create({ id: "nat1", client: "claude", mode: "deliverable", workingDir: "/w", status: "running" });
    store.approvals.create({ id: "nat-appr", sessionId: "nat1", toolName: "Bash", request: { command: "ls" } });
    store.sessions.create({ id: "ic-real", client: "claude", mode: "deliverable", workingDir: "/w", status: "running", backend: "ironcurtain" });
    store.approvals.create({ id: "ic-appr", sessionId: "ic-real", toolName: "mcp__ironcurtain__filesystem__write_file", request: { source: "ironcurtain", escalationId: "e1" } });

    const decided: Array<{ id: string; decision: IcDecision }> = [];
    const bridge: IronCurtainBridge = {
      enabled: () => true,
      listSessions: (): IcSessionView[] => [
        { id: "ic-real", label: 3, persona: "vuln-discovery", status: "running", workingDir: "/w", escalationsPending: 1, createdAt: 1, updatedAt: 1 },
      ],
      listEscalations: (): IcEscalationView[] => [
        { approvalId: "ic-appr", escalationId: "e1", sessionId: "ic-real", sessionLabel: 3, server: "filesystem", tool: "write_file", reason: "outside workspace", arguments: {}, status: "pending", requestedAt: 1 },
      ],
      sessionDigest: (id): IcSessionDigest | undefined => (id === "ic-real" ? { id, label: 3, digest: "status: running" } : undefined),
      decideEscalation: (id, decision): DecideResult => {
        decided.push({ id, decision });
        return { ok: true };
      },
    };
    const icCfg = { ...cfg, ironcurtain: { personasDir: "/nonexistent-personas" } } as unknown as ResolvedConfig;
    const sessions = new SessionManager(store, tmux, icCfg, log);
    server = new DashboardServer({ store, sessions, tmux, cfg: icCfg, log, bridge });
    const { port } = await server.start();
    const base = `http://127.0.0.1:${port}`;

    // Native tab excludes the sandboxed session AND the ironcurtain-sourced approval.
    const state = await (await fetch(`${base}/api/state`)).json();
    expect(state.sessions.map((s: { id: string }) => s.id)).toEqual(["nat1"]);
    expect(state.approvals.map((a: { id: string }) => a.id)).toEqual(["nat-appr"]);

    // Sandboxed tab shows them.
    const ic = await (await fetch(`${base}/api/ironcurtain/state`)).json();
    expect(ic.enabled).toBe(true);
    expect(ic.sessions.map((s: { id: string }) => s.id)).toEqual(["ic-real"]);
    expect(ic.escalations.map((e: { approvalId: string }) => e.approvalId)).toEqual(["ic-appr"]);
    expect(ic.personas).toEqual([]); // personasDir absent → none

    // Digest route.
    const dig = await (await fetch(`${base}/api/ironcurtain/sessions/ic-real/digest`)).json();
    expect(dig.digest).toContain("running");

    // Decide route routes through the bridge AND audits with dashboard:ironcurtain provenance.
    const dec = await fetch(`${base}/api/ironcurtain/escalations/ic-appr/decide`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approved" }),
    });
    expect(dec.status).toBe(200);
    expect(decided).toEqual([{ id: "ic-appr", decision: "approved" }]);
    const aud = store.audit.recent().find((a) => a.type === "approval_decision" && a.payloadJson?.includes("dashboard:ironcurtain"));
    expect(aud?.sessionId).toBe("ic-real");

    // Invalid decision rejected.
    const bad = await fetch(`${base}/api/ironcurtain/escalations/ic-appr/decide`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "maybe" }),
    });
    expect(bad.status).toBe(400);
  });

  it("hides the Sandboxed tab when no bridge is wired (Null bridge)", async () => {
    const store = memoryStore();
    const icCfg = { ...cfg, ironcurtain: { personasDir: "/nonexistent-personas" } } as unknown as ResolvedConfig;
    const sessions = new SessionManager(store, tmux, icCfg, log);
    server = new DashboardServer({ store, sessions, tmux, cfg: icCfg, log }); // no bridge → Null
    const { port } = await server.start();
    const ic = await (await fetch(`http://127.0.0.1:${port}/api/ironcurtain/state`)).json();
    expect(ic.enabled).toBe(false);
    expect(ic.sessions).toEqual([]);
  });
});

describe("DashboardServer — auth (bearer token)", () => {
  const authCfg = {
    tmux: { sessionPrefix: "sw" },
    dashboard: { enabled: true, port: 0, bindAddress: "127.0.0.1", token: "s3cret-token-value" },
  } as unknown as ResolvedConfig;

  it("gates /api routes on the token, but serves the shell page unauthenticated", async () => {
    const store = memoryStore();
    store.sessions.create({ id: "auth1", client: "claude", mode: "deliverable", workingDir: "/w", status: "done" });
    const sessions = new SessionManager(store, tmux, authCfg, log);
    server = new DashboardServer({ store, sessions, tmux, cfg: authCfg, log });
    const { port } = await server.start();
    const base = `http://127.0.0.1:${port}`;

    expect((await fetch(`${base}/api/state`)).status).toBe(401); // no token
    expect((await fetch(`${base}/api/state?token=nope`)).status).toBe(401); // wrong token
    expect((await fetch(`${base}/api/state?token=s3cret-token-value`)).status).toBe(200); // token via query
    const viaHeader = await fetch(`${base}/api/state`, { headers: { authorization: "Bearer s3cret-token-value" } });
    expect(viaHeader.status).toBe(200); // token via Authorization header
    expect((await fetch(`${base}/api/sessions/auth1/kill`, { method: "POST" })).status).toBe(401); // mutating route gated too
    expect((await fetch(`${base}/`)).status).toBe(200); // shell page needs no token
  });

  it("refuses to start when exposed beyond loopback without a token", async () => {
    const store = memoryStore();
    const sessions = new SessionManager(store, tmux, cfg, log);
    const exposed = { tmux: { sessionPrefix: "sw" }, dashboard: { enabled: true, port: 0, bindAddress: "0.0.0.0" } } as unknown as ResolvedConfig;
    const s = new DashboardServer({ store, sessions, tmux, cfg: exposed, log });
    await expect(s.start()).rejects.toThrow(/dashboard|token/i);
    await s.stop();
  });

  it("refuses to start when tailscale.serve is on without a token", async () => {
    const store = memoryStore();
    const sessions = new SessionManager(store, tmux, cfg, log);
    const served = { tmux: { sessionPrefix: "sw" }, dashboard: { enabled: true, port: 0, bindAddress: "127.0.0.1" }, tailscale: { serve: true } } as unknown as ResolvedConfig;
    const s = new DashboardServer({ store, sessions, tmux, cfg: served, log });
    await expect(s.start()).rejects.toThrow(/token/i);
    await s.stop();
  });

  it("treats a hostname bindAddress (e.g. 127.evil.com) as exposed — refuses without a token", async () => {
    const store = memoryStore();
    const sessions = new SessionManager(store, tmux, cfg, log);
    const sneaky = { tmux: { sessionPrefix: "sw" }, dashboard: { enabled: true, port: 0, bindAddress: "127.evil.com" } } as unknown as ResolvedConfig;
    const s = new DashboardServer({ store, sessions, tmux, cfg: sneaky, log });
    await expect(s.start()).rejects.toThrow(/token/i);
    await s.stop();
  });

  it("returns 401 (not 500) for a multibyte token that matches the token's JS length", async () => {
    const store = memoryStore();
    const sessions = new SessionManager(store, tmux, authCfg, log);
    server = new DashboardServer({ store, sessions, tmux, cfg: authCfg, log });
    const { port } = await server.start();
    const multibyte = "é".repeat("s3cret-token-value".length); // same JS length, more bytes
    const r = await fetch(`http://127.0.0.1:${port}/api/state?token=${encodeURIComponent(multibyte)}`);
    expect(r.status).toBe(401);
  });
});
