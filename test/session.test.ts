import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { memoryStore } from "../src/state/db.js";
import { createLogger } from "../src/core/logger.js";
import { Tmux } from "../src/execution/tmux.js";
import { SessionManager, sessionSlug, trustClaudeDir, type SpawnRequest } from "../src/execution/session.js";
import { idSuffix } from "../src/core/ids.js";
import type { ResolvedConfig } from "../src/config/index.js";

const log = createLogger("error");
// Tmux on an unused socket: listSessions() returns [] (no server), so every
// registered tmuxTarget reconciles as "vanished" — exactly the crash/exit case.
const tmux = new Tmux({ socket: "switchboard-session-test" });
const cfg = { tmux: { sessionPrefix: "sw" } } as unknown as ResolvedConfig;

describe("SessionManager.list reconcile (BUG C)", () => {
  it("marks a vanished SDK-runner session FAILED (not done) and fail-closes its orphaned approvals", async () => {
    const store = memoryStore();
    store.sessions.create({
      id: "d1",
      client: "claude",
      mode: "deliverable",
      workingDir: "/w",
      tmuxTarget: "sw-d1",
      status: "running",
    });
    store.approvals.create({ id: "ap1", sessionId: "d1", toolName: "Bash", request: { command: "rm x" } });
    const sm = new SessionManager(store, tmux, cfg, log);

    await sm.list();

    // A crash must NOT be reported as success.
    expect(store.sessions.get("d1")!.status).toBe("failed");
    // The orphaned approval (whose in-process gateway poll died) is fail-closed.
    expect(store.approvals.get("ap1")!.status).toBe("timeout");
    expect(store.approvals.listPending()).toHaveLength(0);
  });

  it("marks a vanished raw-CLI interactive session DONE (normal operator exit)", async () => {
    const store = memoryStore();
    store.sessions.create({
      id: "i1",
      client: "claude",
      mode: "interactive",
      workingDir: "/w",
      tmuxTarget: "sw-i1",
      status: "running",
    });
    const sm = new SessionManager(store, tmux, cfg, log);

    await sm.list();

    expect(store.sessions.get("i1")!.status).toBe("done");
  });

  it("treats a vanished streaming-interactive session as a CRASH (failed), per backend", async () => {
    const store = memoryStore();
    store.sessions.create({
      id: "i2",
      client: "claude",
      mode: "interactive",
      workingDir: "/w",
      tmuxTarget: "sw-i2",
      status: "running",
      backend: "claude_sdk_stream",
    });
    const sm = new SessionManager(store, tmux, cfg, log);
    await sm.list();
    expect(store.sessions.get("i2")!.status).toBe("failed");
  });
});

describe("sessionSlug — descriptive session ids", () => {
  const base = { client: "claude" as const };
  it("uses the repo name when present", () => {
    expect(sessionSlug({ ...base, mode: "interactive", repo: "sip", task: "do some work" })).toBe("sip");
  });
  it("uses 'coord' for coordinated tasks", () => {
    expect(sessionSlug({ ...base, mode: "coordinated", task: "coordinate claude and codex" })).toBe("coord");
  });
  it("derives keywords from the task when there is no repo", () => {
    expect(
      sessionSlug({ ...base, mode: "interactive", task: "start a new session that checks my acme email and identifies high priority tasks" }),
    ).toBe("acme-email");
  });
  it("uses a dirHint when present (no repo)", () => {
    expect(sessionSlug({ ...base, mode: "interactive", dirHint: "my-proj" })).toBe("my-proj");
  });
  it("falls back to 'task' when nothing meaningful remains", () => {
    expect(sessionSlug({ ...base, mode: "interactive", task: "please can you help me" })).toBe("task");
  });
  it("sanitizes to tmux/shell-safe characters", () => {
    expect(sessionSlug({ ...base, mode: "interactive", repo: "Foo.Bar:Baz/Qux" })).toBe("foo-bar-baz-qux");
  });
  it("idSuffix is a short base36 token", () => {
    expect(idSuffix(3)).toMatch(/^[a-z0-9]{3}$/);
  });
});

describe("SessionManager.resume — guards", () => {
  it("refuses to resume a non-streaming session", async () => {
    const store = memoryStore();
    store.sessions.create({ id: "d9", client: "claude", mode: "deliverable", workingDir: "/w", status: "failed", backend: "claude_sdk" });
    const sm = new SessionManager(store, tmux, cfg, log);
    await expect(sm.resume("d9")).rejects.toThrow(/not a resumable/);
  });

  it("refuses to resume a streaming session with no captured SDK session id", async () => {
    const store = memoryStore();
    store.sessions.create({ id: "s9", client: "claude", mode: "interactive", workingDir: "/w", status: "failed", backend: "claude_sdk_stream" });
    const sm = new SessionManager(store, tmux, cfg, log);
    await expect(sm.resume("s9")).rejects.toThrow(/no captured SDK session/);
  });

  it("refuses to resume a session that is not failed (won't clobber a live/ended one)", async () => {
    const store = memoryStore();
    store.sessions.create({ id: "rn1", client: "claude", mode: "interactive", workingDir: "/w", status: "running", backend: "claude_sdk_stream" });
    store.sessions.setClaudeSessionId("rn1", "sdk-x");
    const sm = new SessionManager(store, tmux, cfg, log);
    await expect(sm.resume("rn1")).rejects.toThrow(/only a failed session/);
  });
});

describe("SessionManager.kill — fail-closes the session's pending approvals", () => {
  it("denies pending approvals when a session is killed (no tmux target so kill skips tmux)", async () => {
    const store = memoryStore();
    // No tmuxTarget → kill() skips the tmux call (which would fail on an unused socket).
    store.sessions.create({ id: "k1", client: "claude", mode: "interactive", workingDir: "/w", status: "running" });
    store.approvals.create({ id: "kap1", sessionId: "k1", toolName: "Bash", request: { command: "rm x" } });
    const sm = new SessionManager(store, tmux, cfg, log);

    await sm.kill("k1");

    expect(store.sessions.get("k1")!.status).toBe("killed");
    expect(store.approvals.get("kap1")!.status).toBe("timeout"); // fail-closed, not left pending
    expect(store.approvals.listPending()).toHaveLength(0);
  });
});

describe("SessionManager.spawn — Codex deliverable runs the task", () => {
  function harness() {
    const store = memoryStore();
    const stateDir = mkdtempSync(join(tmpdir(), "sw-sess-"));
    const captured: { command?: string } = {};
    const fakeTmux = {
      newSession: async (o: { name: string; cwd: string; command: string }) => { captured.command = o.command; },
      listSessions: async () => [],
    } as unknown as Tmux;
    const cfg2 = {
      tmux: { sessionPrefix: "sw" },
      stateDir,
      clients: { claude: { enabled: true }, codex: { enabled: true } },
    } as unknown as ResolvedConfig;
    return { sm: new SessionManager(store, fakeTmux, cfg2, log), captured, stateDir };
  }

  it("runs a solo Codex deliverable as `codex exec` with sandbox + approval_policy pinned, reading task.md", async () => {
    const { sm, captured, stateDir } = harness();
    const req: SpawnRequest = { client: "codex", mode: "deliverable", task: "build the thing" };
    const row = await sm.spawn(req);
    expect(captured.command).toContain("codex exec");
    expect(captured.command).toContain("approval_policy=never");
    expect(captured.command).toContain("sandbox_mode=workspace-write");
    // Task text read from disk at run time — never interpolated into the shell string.
    expect(captured.command).toContain(`"$(cat '${stateDir}/sessions/${row.id}/task.md')"`);
    expect(captured.command).not.toContain("build the thing");
  });

  it("keeps an interactive Codex session as bare `codex` (attached, no exec)", async () => {
    const { sm, captured } = harness();
    const req: SpawnRequest = { client: "codex", mode: "interactive" };
    await sm.spawn(req);
    expect(captured.command).toContain("codex");
    expect(captured.command).not.toContain("exec");
  });
});

describe("SessionManager.convertToNative — gated SDK → native CLI (continue anywhere)", () => {
  const ORIGINAL_HOME = process.env.HOME;
  // convert calls trustClaudeDir(workingDir), which writes ~/.claude.json — isolate
  // HOME to a throwaway dir so tests NEVER touch the real one.
  afterEach(() => { process.env.HOME = ORIGINAL_HOME; });

  function harness(liveTargets: string[] = ["sw-strm1"]) {
    const fakeHome = mkdtempSync(join(tmpdir(), "sw-home-"));
    process.env.HOME = fakeHome;
    const store = memoryStore();
    const respawns: { target: string; command: string; cwd?: string }[] = [];
    const fakeTmux = {
      listSessions: async () => liveTargets,
      respawnPane: async (target: string, command: string, cwd?: string) => {
        respawns.push({ target, command, cwd });
      },
    } as unknown as Tmux;
    const cfg2 = {
      tmux: { sessionPrefix: "sw" },
      clients: { claude: { enabled: true, cliPath: "claude" }, codex: { enabled: true } },
    } as unknown as ResolvedConfig;
    return { store, sm: new SessionManager(store, fakeTmux, cfg2, log), respawns, fakeHome };
  }

  function liveStream(store: ReturnType<typeof memoryStore>, id = "strm1", claudeSessionId: string | null = "654a6192-ef68-4059-9936-35436702f859") {
    store.sessions.create({ id, client: "claude", mode: "interactive", workingDir: "/work/proj", tmuxTarget: `sw-${id}`, status: "running", backend: "claude_sdk_stream" });
    if (claudeSessionId) store.sessions.setClaudeSessionId(id, claudeSessionId);
  }

  it("resumes the SDK session as native `claude --resume` in the same pane+cwd, flips backend, and audits the posture change", async () => {
    const { store, sm, respawns } = harness();
    liveStream(store);
    const out = await sm.convertToNative("strm1", {});
    expect(respawns).toHaveLength(1);
    expect(respawns[0]!.target).toBe("sw-strm1");
    expect(respawns[0]!.cwd).toBe("/work/proj"); // same cwd → --resume finds the transcript
    expect(respawns[0]!.command).toContain("claude");
    expect(respawns[0]!.command).toContain("--resume '654a6192-ef68-4059-9936-35436702f859'");
    expect(respawns[0]!.command).not.toContain("--remote-control");
    expect(out.backend).toBe("claude_cli_console");
    const audit = store.audit.recent().find((a) => a.type === "status_change" && a.payloadJson?.includes("convert_to_native"));
    expect(audit).toBeTruthy();
  });

  it("adds --remote-control for the phone target", async () => {
    const { store, sm, respawns } = harness();
    liveStream(store);
    await sm.convertToNative("strm1", { remoteControl: true });
    expect(respawns[0]!.command).toContain("--remote-control");
    expect(respawns[0]!.command).toContain("--resume");
  });

  it("fail-closes the session's pending approvals on convert (the SDK runner's gateway poll dies with it)", async () => {
    const { store, sm } = harness();
    liveStream(store);
    store.approvals.create({ id: "cvap1", sessionId: "strm1", toolName: "mcp__claude_ai_Gmail__search_threads", request: {} });
    await sm.convertToNative("strm1", {});
    expect(store.approvals.get("cvap1")!.status).toBe("timeout");
    expect(store.approvals.listPending()).toHaveLength(0);
  });

  it("refuses to convert a non-streaming session", async () => {
    const { store, sm } = harness();
    store.sessions.create({ id: "cli1", client: "claude", mode: "interactive", workingDir: "/w", tmuxTarget: "sw-cli1", status: "running", backend: "claude_cli_console" });
    await expect(sm.convertToNative("cli1", {})).rejects.toThrow(/gated streaming session/);
  });

  it("refuses to convert a streaming session that never captured an SDK session id", async () => {
    const { store, sm } = harness();
    liveStream(store, "strm1", null);
    await expect(sm.convertToNative("strm1", {})).rejects.toThrow(/no captured SDK session/);
  });

  it("refuses to convert when the pane is no longer live", async () => {
    const { store, sm } = harness([]); // listSessions returns nothing → pane vanished
    liveStream(store);
    await expect(sm.convertToNative("strm1", {})).rejects.toThrow(/no live pane/);
  });

  it("pre-accepts the folder-trust dialog for the working dir (so the detached native session doesn't block)", async () => {
    const { store, sm, fakeHome } = harness();
    writeFileSync(join(fakeHome, ".claude.json"), JSON.stringify({ projects: {} }));
    liveStream(store);
    await sm.convertToNative("strm1", {});
    const cfg = JSON.parse(readFileSync(join(fakeHome, ".claude.json"), "utf8"));
    expect(cfg.projects["/work/proj"].hasTrustDialogAccepted).toBe(true);
  });
});

describe("trustClaudeDir", () => {
  it("sets hasTrustDialogAccepted for a dir, preserving the rest of ~/.claude.json", () => {
    const home = mkdtempSync(join(tmpdir(), "sw-cj-"));
    const p = join(home, ".claude.json");
    writeFileSync(p, JSON.stringify({ projects: { "/other": { hasTrustDialogAccepted: true, x: 1 } }, numStartups: 5 }));
    expect(trustClaudeDir("/work/proj", p)).toBe(true);
    const cfg = JSON.parse(readFileSync(p, "utf8"));
    expect(cfg.projects["/work/proj"].hasTrustDialogAccepted).toBe(true);
    expect(cfg.projects["/other"].x).toBe(1); // existing project entry preserved
    expect(cfg.numStartups).toBe(5); // unrelated top-level keys preserved
  });

  it("is a safe no-op (returns false, no throw) when the config file is missing", () => {
    const missing = join(mkdtempSync(join(tmpdir(), "sw-cj-")), "nope.json");
    expect(trustClaudeDir("/x", missing)).toBe(false);
  });
});
