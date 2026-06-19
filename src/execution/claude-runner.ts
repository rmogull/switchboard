import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { query } from "@anthropic-ai/claude-agent-sdk";

import { buildGatedSdkOptions } from "../permissions/session-options.js";
import { SwitchboardError } from "../core/errors.js";
import { MemoryService } from "../memory/service.js";
import { MemoryStore } from "../memory/memory.js";
import { openGatedSession } from "./gated-setup.js";

/**
 * Run a headless (deliverable/coordinated) Claude session via the Agent SDK
 * (§5.4). This is the gated execution path: every tool-use flows through the
 * permission policy + approval gateway via canUseTool, under SDK isolation
 * (settingSources:[]) so the policy is authoritative. Runs inside a tmux pane as
 * `switchboard run-session <id>`, so its streamed output is attachable and shows
 * in the dashboard log view; approvals cross to the daemon via the approvals
 * table. Writes a summary and marks the session done/failed on exit.
 */
export async function runSession(sessionId: string): Promise<void> {
  const { cfg, log, store, session, contextPrefix, canUseTool } = openGatedSession(
    sessionId,
    "runner",
  );

  const taskPath = join(cfg.stateDir, "sessions", sessionId, "task.md");
  const task = existsSync(taskPath) ? readFileSync(taskPath, "utf8").trim() : "";
  if (!task) {
    store.sessions.setStatus(sessionId, "failed");
    store.close();
    throw new SwitchboardError("no_task", `run-session: no task for '${sessionId}'`);
  }

  const prompt = contextPrefix ? `${contextPrefix}\n\n# Task\n\n${task}` : task;

  store.sessions.setStatus(sessionId, "running");
  store.audit.append({
    type: "status_change",
    sessionId,
    source: `session:${sessionId}`,
    payload: { event: "runner_start" },
  });
  log.info("runner starting", { workingDir: session.workingDir });

  try {
    const res = query({
      prompt,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      options: buildGatedSdkOptions({
        cwd: session.workingDir,
        canUseTool,
        disallowedTools: ["AskUserQuestion"], // headless: model must act, not punt
      }) as any,
    });

    let summary = "";
    for await (const m of res) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mm = m as any;
      if (mm.type === "assistant") {
        for (const b of mm.message?.content ?? []) {
          if (b.type === "text" && b.text) process.stdout.write(b.text);
        }
      }
      if (mm.type === "result") summary = String(mm.result ?? mm.subtype ?? "");
    }

    store.sessions.setSummary(sessionId, summary.slice(0, 2000));
    store.sessions.setStatus(sessionId, "done");
    store.audit.append({
      type: "status_change",
      sessionId,
      source: `session:${sessionId}`,
      payload: { event: "runner_done" },
    });
    // Ingest any memory proposals the child wrote to its scratch (§5.6 child→propose).
    try {
      const n = new MemoryService(store, new MemoryStore(cfg.home)).ingestSessionProposals(sessionId, session.workingDir);
      if (n) log.info("ingested memory proposals", { count: n });
    } catch (e) {
      log.warn("memory proposal ingest failed", { err: String(e) });
    }
    // Notify the operator that the unattended deliverable finished (§5.4 notify-on-done).
    store.outbound.enqueue({
      sessionId,
      kind: "result",
      body: `✅ ${session.mode} ${sessionId} done${summary ? ": " + summary.split("\n")[0]!.slice(0, 200) : ""}`,
    });
    log.info("runner done");
  } catch (err) {
    store.sessions.setStatus(sessionId, "failed");
    store.audit.append({
      type: "error",
      sessionId,
      source: `session:${sessionId}`,
      payload: { stage: "runner", error: String(err) },
    });
    log.error("runner failed", { err: String(err) });
    throw err;
  } finally {
    store.close();
  }
}
