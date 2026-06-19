import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Shared, hoisted holder so the (hoisted) mock can record interrupt() calls.
const holder = vi.hoisted(() => ({ interrupts: 0 }));

// Fake SDK: drain the streaming input (racing a short timeout so it never blocks
// on a parked stream), emit init/assistant/result, then end. Exposes interrupt().
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: ({ prompt }: any) => {
    const gen = (async function* () {
      const it = prompt[Symbol.asyncIterator]();
      yield { type: "system", subtype: "init", session_id: "sdk-test-123" };
      for (let i = 0; i < 6; i++) {
        const n = await Promise.race([
          it.next(),
          new Promise<{ done: boolean }>((r) => setTimeout(() => r({ done: true }), 60)),
        ]);
        if ((n as { done?: boolean }).done) break;
      }
      yield { type: "assistant", message: { content: [{ type: "text", text: "ack" }] } };
      yield { type: "result", subtype: "success", result: "final answer" };
    })();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gen as any).interrupt = async () => {
      holder.interrupts++;
    };
    return gen;
  },
}));

import { Store } from "../src/state/db.js";
import { runStreamingSession } from "../src/execution/streaming-runner.js";

let dir: string;
beforeEach(() => {
  holder.interrupts = 0;
  dir = mkdtempSync(join(tmpdir(), "sw-strun-"));
  const cfgPath = join(dir, "config.json");
  writeFileSync(cfgPath, JSON.stringify({ home: dir, stateDir: dir, dbPath: join(dir, "db.sqlite") }));
  process.env.SWITCHBOARD_CONFIG = cfgPath;
});
afterEach(() => {
  delete process.env.SWITCHBOARD_CONFIG;
});

describe("runStreamingSession (mocked SDK)", () => {
  it("drains steering, captures the SDK session id, digests output, writes a transcript, ends done", async () => {
    const dbPath = join(dir, "db.sqlite");
    const setup = new Store(dbPath);
    setup.sessions.create({
      id: "st1",
      client: "claude",
      mode: "interactive",
      workingDir: dir,
      status: "starting",
      backend: "claude_sdk_stream",
    });
    setup.steering.enqueue({ sessionId: "st1", source: "signal", sender: "+1me", body: "do the thing" });
    mkdirSync(join(dir, "sessions", "st1"), { recursive: true });
    writeFileSync(join(dir, "sessions", "st1", "task.md"), "initial task");
    setup.close();

    await runStreamingSession("st1");

    const v = new Store(dbPath);
    try {
      const s = v.sessions.get("st1")!;
      expect(s.claudeSessionId).toBe("sdk-test-123");
      expect(s.status).toBe("done");
      expect(s.summary).toContain("final answer");
      expect(v.audit.recent().some((a) => a.type === "steering_message")).toBe(true);
      const kinds = v.outbound.listQueued().map((o) => o.kind);
      expect(kinds).toContain("status");
      expect(kinds).toContain("result");
      const tr = v.transcript.listRecent("st1", 100);
      expect(tr.some((r) => r.kind === "user" && r.text.includes("initial task"))).toBe(true);
      expect(tr.some((r) => r.kind === "assistant" && r.text === "ack")).toBe(true);
      expect(tr.some((r) => r.kind === "result" && r.text.includes("final answer"))).toBe(true);
      expect(tr.some((r) => r.kind === "status" && r.text === "running")).toBe(true);
    } finally {
      v.close();
    }
  });

  it("intercepts a /interrupt steering turn locally (calls interrupt, never yields it as a turn)", async () => {
    const dbPath = join(dir, "db.sqlite");
    const setup = new Store(dbPath);
    setup.sessions.create({
      id: "si1",
      client: "claude",
      mode: "interactive",
      workingDir: dir,
      status: "starting",
      backend: "claude_sdk_stream",
    });
    // No task.md — first input is /interrupt, then a real turn.
    setup.steering.enqueue({ sessionId: "si1", source: "signal", sender: "+1me", body: "/interrupt" });
    setup.steering.enqueue({ sessionId: "si1", source: "signal", sender: "+1me", body: "real turn" });
    setup.close();

    await runStreamingSession("si1");

    expect(holder.interrupts).toBe(1); // interrupt() was called
    const v = new Store(dbPath);
    try {
      const tr = v.transcript.listRecent("si1", 100);
      // /interrupt is a control command — never a user turn — but the real turn is.
      expect(tr.some((r) => r.kind === "user" && r.text === "/interrupt")).toBe(false);
      expect(tr.some((r) => r.kind === "user" && r.text === "real turn")).toBe(true);
      expect(tr.some((r) => r.kind === "status" && r.text === "interrupted")).toBe(true);
    } finally {
      v.close();
    }
  });

  it("does not replay task.md when resuming (SDK restores the conversation)", async () => {
    const dbPath = join(dir, "db.sqlite");
    const setup = new Store(dbPath);
    setup.sessions.create({
      id: "sr1",
      client: "claude",
      mode: "interactive",
      workingDir: dir,
      status: "failed",
      backend: "claude_sdk_stream",
    });
    setup.sessions.setClaudeSessionId("sr1", "sdk-x");
    mkdirSync(join(dir, "sessions", "sr1"), { recursive: true });
    writeFileSync(join(dir, "sessions", "sr1", "task.md"), "the original task");
    setup.close();

    await runStreamingSession("sr1", { resume: true });

    const v = new Store(dbPath);
    try {
      const tr = v.transcript.listRecent("sr1", 100);
      expect(tr.some((r) => r.kind === "user" && r.text.includes("the original task"))).toBe(false);
    } finally {
      v.close();
    }
  });

  it("fails closed on --resume when the session has no captured SDK id (direct entrypoint guard)", async () => {
    const dbPath = join(dir, "db.sqlite");
    const setup = new Store(dbPath);
    setup.sessions.create({
      id: "nr1",
      client: "claude",
      mode: "interactive",
      workingDir: dir,
      status: "failed",
      backend: "claude_sdk_stream",
    }); // no claudeSessionId captured
    setup.close();
    await expect(runStreamingSession("nr1", { resume: true })).rejects.toThrow(/resumable|resume/i);
  });
});
