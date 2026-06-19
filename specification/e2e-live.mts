// Live end-to-end test of the NEW streaming runner against REAL Claude — fully
// isolated from the production daemon: scratch config/stateDir/DB, signal OFF, no
// shared tmux socket (the runner is driven directly as a child process). Validates
// the SDK behaviors the mocked tests stand in for: streaming boot + session-id
// capture, canUseTool gating under streaming, live Signal-style steering (via the
// steering_inbox), the durable transcript, /interrupt interception, and resume.
//
// Run: node_modules/.bin/tsx specification/e2e-live.mts
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

import { Store } from "../src/state/db.js";

const PROJECT = process.env.SWITCHBOARD_PROJECT ?? process.cwd();
const ROOT = "/tmp/sw-e2e";
const STATE = join(ROOT, "state");
const REPO = join(ROOT, "repo");
const CONFIG = join(ROOT, "config.json");
const TSX = join(PROJECT, "node_modules/.bin/tsx");

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const log = (...a: unknown[]) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const results: { phase: string; ok: boolean; detail: string }[] = [];
const record = (phase: string, ok: boolean, detail: string) => {
  results.push({ phase, ok, detail });
  log(`${ok ? "PASS" : "FAIL"} — ${phase}: ${detail}`);
};

async function waitFor<T>(what: string, fn: () => T | undefined, timeoutMs: number): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v !== undefined && v !== null && (!Array.isArray(v) || v.length)) return v;
    if (Date.now() >= deadline) return undefined;
    await sleep(1000);
  }
}

function startRunner(id: string, resume: boolean): ChildProcess {
  const args = ["src/cli/index.ts", "run-session", id, "--interactive", ...(resume ? ["--resume"] : [])];
  const child = spawn(TSX, args, {
    cwd: PROJECT,
    env: { ...process.env, SWITCHBOARD_CONFIG: CONFIG },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d) => process.stdout.write(`  [runner] ${d}`));
  child.stderr?.on("data", (d) => process.stdout.write(`  [runner!] ${d}`));
  return child;
}

async function main() {
  // ---- setup (isolated) ----
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(STATE, { recursive: true });
  mkdirSync(REPO, { recursive: true });
  writeFileSync(
    CONFIG,
    JSON.stringify(
      {
        home: join(ROOT, "home"),
        stateDir: STATE,
        signal: { enabled: false },
        dashboard: { enabled: false },
        // omit `clients` → schema defaults (claude + codex) so validation passes
      },
      null,
      2,
    ),
  );
  process.env.SWITCHBOARD_CONFIG = CONFIG;
  const dbPath = join(STATE, "switchboard.db");
  const id = "e2e1";

  const setup = new Store(dbPath);
  setup.sessions.create({ id, client: "claude", mode: "interactive", workingDir: REPO, status: "starting", backend: "claude_sdk_stream" });
  mkdirSync(join(STATE, "sessions", id), { recursive: true });
  writeFileSync(
    join(STATE, "sessions", id, "task.md"),
    "Use the Bash tool to run exactly this command and nothing else: curl -sS -o /dev/null -w '%{http_code}' https://example.com . Then tell me the HTTP status code in one short sentence.",
  );
  setup.close();
  log(`setup done — scratch at ${ROOT}, session ${id}`);

  const db = new Store(dbPath);
  let runner = startRunner(id, false);

  // ---- phase 1: streaming boot + SDK session-id capture ----
  const booted = await waitFor("sdk_id", () => db.sessions.get(id)?.claudeSessionId ?? undefined, 60_000);
  record("1 streaming boot + session-id capture", Boolean(booted), booted ? `claude_session_id=${String(booted).slice(0, 12)}…` : "no SDK init within 60s");

  // ---- phase 2: canUseTool gating under streaming (curl → network_egress → ask) ----
  const pending = await waitFor("approval", () => { const p = db.approvals.listPending(); return p.length ? p : undefined; }, 90_000);
  if (pending && pending.length) {
    const ap = pending[0]!;
    record("2 canUseTool fires under streaming", true, `approval for ${ap.toolName}: ${ap.requestJson.slice(0, 80)}`);
    const ok = db.approvals.decide(ap.id, "approved", "dashboard");
    log(`approved ${ap.id.slice(0, 8)} (decide=${ok})`);
  } else {
    record("2 canUseTool fires under streaming", false, "no approval appeared within 90s");
  }

  // ---- phase 3: tool ran + transcript written ----
  const gotResult = await waitFor("result", () => { const t = db.transcript.listRecent(id, 100); return t.some((r) => r.kind === "result") ? t : undefined; }, 90_000);
  if (gotResult) {
    const res = gotResult.filter((r) => r.kind === "result").map((r) => r.text).join(" / ");
    const mentions200 = /\b200\b/.test(res) || gotResult.some((r) => r.kind === "assistant" && /\b200\b/.test(r.text));
    record("3 approved tool ran + transcript", true, `result mentions HTTP 200=${mentions200}; transcript rows=${gotResult.length}`);
  } else {
    record("3 approved tool ran + transcript", false, "no result transcript within 90s");
  }

  // ---- phase 4: live steering over the steering_inbox ----
  const beforeSteer = db.transcript.listRecent(id, 500).length;
  db.steering.enqueue({ sessionId: id, source: "signal", sender: "+1test", body: "Now reply with exactly the word PINEAPPLE and nothing else." });
  log("enqueued steering turn");
  const steered = await waitFor("steer-reply", () => { const t = db.transcript.listRecent(id, 500); return t.length > beforeSteer && t.slice(beforeSteer).some((r) => r.kind === "assistant" && /PINEAPPLE/i.test(r.text)) ? t : undefined; }, 90_000);
  record("4 live steering (Signal-style)", Boolean(steered), steered ? "model answered the steered turn (PINEAPPLE)" : "no steered reply within 90s");

  // ---- phase 5: /interrupt interception ----
  db.steering.enqueue({ sessionId: id, source: "signal", sender: "+1test", body: "/interrupt" });
  log("enqueued /interrupt");
  const interrupted = await waitFor("interrupt", () => { const t = db.transcript.listRecent(id, 500); return t.some((r) => r.kind === "status" && r.text === "interrupted") ? t : undefined; }, 30_000);
  const interruptNotAUserTurn = !db.transcript.listRecent(id, 500).some((r) => r.kind === "user" && r.text.trim() === "/interrupt");
  record("5 /interrupt intercepted locally", Boolean(interrupted) && interruptNotAUserTurn, interrupted ? `status 'interrupted' recorded; never a user turn=${interruptNotAUserTurn}` : "no interrupt status within 30s");

  // ---- phase 6: resume restores conversation context ----
  const sdkId = db.sessions.get(id)?.claudeSessionId;
  log("killing runner to simulate a crash…");
  runner.kill("SIGKILL");
  await sleep(2000);
  db.sessions.setStatus(id, "failed"); // reconcile would do this for a vanished pane
  if (sdkId) {
    log(`resuming with captured sdk id ${String(sdkId).slice(0, 12)}…`);
    runner = startRunner(id, true);
    await waitFor("resume-boot", () => (db.sessions.get(id)?.status === "running" ? true : undefined), 30_000);
    const beforeResume = db.transcript.listRecent(id, 1000).length;
    db.steering.enqueue({ sessionId: id, source: "signal", sender: "+1test", body: "In one short sentence: what exact shell command did I first ask you to run?" });
    const resumed = await waitFor("resume-reply", () => { const t = db.transcript.listRecent(id, 1000); return t.length > beforeResume && t.slice(beforeResume).some((r) => r.kind === "assistant" && /curl/i.test(r.text)) ? t : undefined; }, 90_000);
    record("6 resume restores conversation", Boolean(resumed), resumed ? "resumed session recalled the original curl command (context restored)" : "resumed session did not recall context within 90s");
  } else {
    record("6 resume restores conversation", false, "no SDK id was captured to resume from");
  }

  // ---- teardown + summary ----
  runner.kill("SIGKILL");
  db.close();
  console.log("\n================ LIVE E2E SUMMARY ================");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.phase} — ${r.detail}`);
  const passed = results.filter((r) => r.ok).length;
  console.log(`-------------------------------------------------\n${passed}/${results.length} phases passed`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error("E2E ERROR:", e?.stack || e);
  process.exit(2);
});
