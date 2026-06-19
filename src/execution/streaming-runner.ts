import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import { buildGatedSdkOptions } from "../permissions/session-options.js";
import { toSignalDigest } from "../control/signal-digest.js";
import {
  formatApprovalPrompt,
  parseApprovalReply,
  resolveApprovalTarget,
} from "../control/approval-notifier.js";
import { SwitchboardError } from "../core/errors.js";
import { openGatedSession } from "./gated-setup.js";
import { mergedInput } from "./input-mux.js";

const POLL_MS = 1000;

function userTurn(text: string): SDKUserMessage {
  return { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
}

/** Write an operator-facing line into the pane, set off from the model stream. */
function writePane(text: string): void {
  process.stdout.write(`\n${text}\n`);
}

/**
 * Run a long-lived INTERACTIVE Claude session via the Agent SDK in streaming-input
 * mode (§5.5, the remote default). Same gated spine as the deliverable runner —
 * every tool-use flows through canUseTool → policy → approval gateway under
 * settingSources:[] isolation — but the prompt is an AsyncIterable that yields the
 * initial task then drains the steering_inbox, so the operator can keep steering
 * the session over Signal (and, in Inc2, the pane). Output goes to stdout (the
 * pane) and a verbosity-filtered digest to the outbound queue (→ Signal).
 *
 * Permission mode is pinned to 'default' and setPermissionMode is NEVER called;
 * options are built ONLY via buildGatedSdkOptions, so the policy stays the sole
 * authority (Invariant 7). Runs as `switchboard run-session <id> --interactive`.
 */
export async function runStreamingSession(
  sessionId: string,
  opts: { resume?: boolean } = {},
): Promise<void> {
  const { cfg, log, store, session, contextPrefix, canUseTool } = openGatedSession(
    sessionId,
    "stream-runner",
    // Render every approval into the pane the moment it's created, so an operator
    // who takes over the terminal SEES what's pending (not only Signal/dashboard).
    { onApprovalRequest: (a) => writePane(formatApprovalPrompt(a)) },
  );

  // Decide a pending approval from a typed pane line (`y`/`n`/`ya <id>`), or list
  // the queue with `/approvals`. Returns true when the line was consumed as control
  // (so it never becomes a model turn). Runs at the pane line-event level, so it
  // works even while the SDK turn is parked on the very approval being answered.
  const handlePaneControl = (line: string): boolean => {
    const t = line.trim();
    if (t === "/approvals" || t === "/pending") {
      const pend = store.approvals.listPending().filter((a) => a.sessionId === sessionId);
      writePane(pend.length ? pend.map(formatApprovalPrompt).join("\n\n") : "(no pending approvals)");
      return true;
    }
    const parsed = parseApprovalReply(t);
    if (!parsed) return false;
    const pend = store.approvals.listPending().filter((a) => a.sessionId === sessionId);
    // Nothing to answer → let a plain "yes"/"no" reach the model as a normal turn.
    if (pend.length === 0) return false;
    const resolved = resolveApprovalTarget(pend, parsed);
    if ("error" in resolved) {
      writePane(resolved.error);
      return true;
    }
    const scope = parsed.approve && parsed.session ? "session" : "once";
    const decided = store.approvals.decide(
      resolved.target.id,
      parsed.approve ? "approved" : "denied",
      "pane",
      scope,
    );
    const id8 = resolved.target.id.slice(0, 8);
    const verb = parsed.approve ? (scope === "session" ? "approved (for session)" : "approved") : "denied";
    writePane(decided ? `✓ ${verb} ${id8}` : `already decided ${id8}`);
    return true;
  };

  // Fail closed if asked to resume something that isn't an eligible streaming
  // session with a captured SDK id — so this entrypoint is safe even if invoked
  // directly (not only via the guarded SessionManager.resume).
  if (opts.resume && (session.backend !== "claude_sdk_stream" || !session.claudeSessionId)) {
    store.close();
    throw new SwitchboardError(
      "not_resumable",
      `run-session --resume: '${sessionId}' has no resumable SDK session`,
    );
  }

  // Aborted in the finally so the input mux tears down cleanly (detaches pane
  // stdin, stops the steering poller) when the session ends.
  const inputAbort = new AbortController();
  // Set after query() so an operator `/interrupt` can stop the in-flight turn.
  let queryHandle: { interrupt?: () => Promise<void> } | undefined;
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const interruptCurrentTurn = async (): Promise<void> => {
    // The SDK may begin consuming the prompt before query() returns and assigns
    // queryHandle, so wait briefly for it — an early /interrupt isn't dropped.
    for (let i = 0; i < 50 && !queryHandle; i++) await sleep(10);
    try {
      await queryHandle?.interrupt?.();
    } catch (e) {
      log.warn("interrupt failed", { err: String(e) });
    }
  };

  const enqueueDigest = (kind: "status" | "result" | "notice", text: string): void => {
    const body = toSignalDigest({ kind, text }, sessionId);
    if (body) store.outbound.enqueue({ sessionId, kind, body });
  };
  // Status goes to BOTH the durable transcript (dashboard) and the Signal digest.
  const recordStatus = (text: string): void => {
    store.transcript.append({ sessionId, kind: "status", source: "session", text });
    enqueueDigest("status", text);
  };

  // The ordered SDK input: the initial task (DATA-framed), then turns merged from
  // the attached pane's stdin AND the steering_inbox (one ordered stream). The
  // generator stays open for the life of the session; the process is ended by
  // `switchboard kill` (→ status killed) or by a crash (reconciled to failed).
  async function* inputStream(): AsyncGenerator<SDKUserMessage> {
    const taskPath = join(cfg.stateDir, "sessions", sessionId, "task.md");
    const initialTask = existsSync(taskPath) ? readFileSync(taskPath, "utf8").trim() : "";
    // On resume the SDK restores the prior conversation (which already contains the
    // original task), so DON'T replay task.md — that would re-execute it.
    if (initialTask && !opts.resume) {
      store.transcript.append({ sessionId, kind: "user", source: "session", text: initialTask });
      yield userTurn(contextPrefix ? `${contextPrefix}\n\n# Task\n\n${initialTask}` : initialTask);
    }
    for await (const turn of mergedInput({
      steeringRows: () => store.steering.listQueued(sessionId),
      pollMs: POLL_MS,
      // Only read the pane when it's a real interactive TTY (an attached tmux
      // pane). Headless/test contexts have no pane stdin to steer from.
      stdin: process.stdin.isTTY ? process.stdin : undefined,
      // Approval replies / `/approvals` typed in the pane are intercepted here and
      // never become a model turn — so an operator taking over the terminal can
      // answer a parked approval inline.
      onPaneControl: handlePaneControl,
      signal: inputAbort.signal,
    })) {
      const cmd = turn.body.trim();
      // Control commands are intercepted LOCALLY and never become a model turn
      // (Invariant 4). `/interrupt` stops the in-flight turn; the SDK aborts the
      // turn's canUseTool signal, releasing any parked approval. setPermissionMode
      // is deliberately NOT a command — mode can never be relaxed mid-session.
      if (cmd === "/interrupt" || cmd === "/stop") {
        store.audit.append({
          type: "status_change",
          sessionId,
          source:
            turn.source === "signal" && turn.sender ? `signal:${turn.sender}` : `session:${sessionId}`,
          payload: { event: "interrupt", source: turn.source },
        });
        store.transcript.append({ sessionId, kind: "status", source: "session", text: "interrupted" });
        await interruptCurrentTurn();
        if (turn.steeringId != null) store.steering.consume(turn.steeringId);
        continue;
      }
      // Audit the delivery, yield the turn, and only THEN consume a steering row:
      // the SDK pulls the next item before we reach consume(), so the row stays
      // 'queued' until the SDK accepts it (at-least-once, never silently lost).
      store.audit.append({
        type: "steering_message",
        sessionId,
        source:
          turn.source === "signal" && turn.sender ? `signal:${turn.sender}` : `session:${sessionId}`,
        payload: { source: turn.source, bytes: turn.body.length, steeringId: turn.steeringId },
      });
      store.transcript.append({ sessionId, kind: "user", source: turn.source, text: turn.body });
      yield userTurn(turn.body);
      if (turn.steeringId != null) store.steering.consume(turn.steeringId);
    }
  }

  store.sessions.setStatus(sessionId, "running");
  store.audit.append({
    type: "status_change",
    sessionId,
    source: `session:${sessionId}`,
    payload: { event: "stream_runner_start" },
  });
  recordStatus("running");
  log.info("stream runner starting", { workingDir: session.workingDir });

  try {
    const baseOptions = buildGatedSdkOptions({
      cwd: session.workingDir,
      canUseTool,
      disallowedTools: ["AskUserQuestion"],
    });
    // Operator-gated crash-resume: only when explicitly asked AND we captured the
    // SDK session id. Never auto-resumes (a session that died mid-action is not
    // silently resurrected) — settingSources:[]/permissionMode stay pinned.
    const sdkOptions =
      opts.resume && session.claudeSessionId
        ? { ...baseOptions, resume: session.claudeSessionId }
        : baseOptions;
    const res = query({
      prompt: inputStream(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      options: sdkOptions as any,
    });
    queryHandle = res as unknown as { interrupt?: () => Promise<void> };

    let assistantBuf = "";
    for await (const m of res) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mm = m as any;
      if (mm.type === "system" && mm.subtype === "init" && mm.session_id) {
        store.sessions.setClaudeSessionId(sessionId, String(mm.session_id));
      }
      if (mm.type === "assistant") {
        let msgText = "";
        for (const b of mm.message?.content ?? []) {
          if (b.type === "text" && b.text) {
            process.stdout.write(b.text);
            msgText += b.text;
          }
        }
        if (msgText.trim()) {
          assistantBuf += msgText;
          // One transcript row per assistant message (not per token) — the
          // dashboard shows the full conversation; Signal only gets the digest.
          store.transcript.append({ sessionId, kind: "assistant", source: "model", text: msgText });
        }
      }
      if (mm.type === "result") {
        const text = String(mm.result ?? mm.subtype ?? "").trim() || assistantBuf.trim();
        assistantBuf = "";
        if (text) {
          store.sessions.setSummary(sessionId, text.slice(0, 2000));
          store.transcript.append({ sessionId, kind: "result", source: "model", text });
          enqueueDigest("result", text);
        }
      }
    }

    // Reached only if the input stream ever ends (it normally does not).
    store.sessions.setStatus(sessionId, "done");
    store.audit.append({
      type: "status_change",
      sessionId,
      source: `session:${sessionId}`,
      payload: { event: "stream_runner_done" },
    });
    recordStatus("done");
  } catch (err) {
    store.sessions.setStatus(sessionId, "failed");
    store.audit.append({
      type: "error",
      sessionId,
      source: `session:${sessionId}`,
      payload: { stage: "stream_runner", error: String(err) },
    });
    recordStatus(`failed: ${String(err)}`.slice(0, 200));
    log.error("stream runner failed", { err: String(err) });
    throw err;
  } finally {
    inputAbort.abort();
    store.close();
  }
}
