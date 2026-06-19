import { StringDecoder } from "node:string_decoder";

import type { SteeringRow, SteeringSource } from "../state/types.js";

export interface MuxTurn {
  body: string;
  source: "pane" | SteeringSource;
  sender: string | null;
  /** Present for steering_inbox rows so the caller can consume() after delivery. */
  steeringId: number | null;
}

export interface MergedInputOpts {
  /** Snapshot the currently-queued steering rows for this session. */
  steeringRows: () => SteeringRow[];
  /** Poll interval for the steering inbox. */
  pollMs: number;
  /** The attached pane's stdin, if any. Read line-by-line; EOF does NOT end the stream. */
  stdin?: NodeJS.ReadStream | undefined;
  /**
   * Intercept a pane line BEFORE it becomes a model turn. Return true to consume it
   * (e.g. an approval reply / `/approvals`), false to let it flow as a user turn.
   * Runs at the line-event level (not on SDK pull), so it works even while the SDK
   * turn is parked waiting on an approval — which is exactly when an operator who
   * just took over the pane needs to answer one. Pane lines only (steering rows are
   * always DATA).
   */
  onPaneControl?: ((line: string) => boolean) | undefined;
  /** Stop the merge (shutdown / interrupt). */
  signal?: AbortSignal | undefined;
  /** Injectable sleep (tests). */
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const MAX_LINE = 8_000; // cap a single pane line
const MAX_QUEUE = 1_000; // cap the in-memory merge queue (sheds pane flood)

/**
 * Merge the two operator-input sources — the attached tmux pane's stdin and the
 * durable steering_inbox — into ONE ordered stream of turns. One pane line = one
 * turn; one steering row = one turn. Both produce ONLY user turns (DATA); neither
 * can emit a control request (Invariant 4). Properties:
 *
 *  - Pane EOF (a detached `-d` pane) does NOT terminate the stream — the session
 *    keeps serving the Signal relay; stdin is simply quiet.
 *  - Partial multi-byte UTF-8 across chunk boundaries is handled (StringDecoder).
 *  - Steering rows are de-duplicated across polls: a row stays 'queued' until the
 *    caller consumes it AFTER the SDK accepts the turn (at-least-once), so the
 *    poller must not re-emit an already-pushed-but-unconsumed row. The pushed-set
 *    is pruned to rows still queued, so a fresh runner after a crash re-emits an
 *    un-consumed row (at-least-once) while a single run never double-emits.
 */
export async function* mergedInput(opts: MergedInputOpts): AsyncGenerator<MuxTurn> {
  const sleep = opts.sleep ?? defaultSleep;
  const queue: MuxTurn[] = [];
  const pushed = new Set<number>(); // steering ids already emitted (pruned to still-queued)
  let wake: (() => void) | null = null;
  let stopped = false;

  const push = (t: MuxTurn): void => {
    queue.push(t);
    if (wake) {
      const w = wake;
      wake = null;
      w();
    }
  };
  const nudge = (): void => {
    if (wake) {
      const w = wake;
      wake = null;
      w();
    }
  };

  // Pane stdin producer (line-buffered, UTF-8 safe). Absent when not attached.
  let detachStdin = (): void => {};
  if (opts.stdin) {
    const decoder = new StringDecoder("utf8");
    let buf = "";
    const onData = (chunk: Buffer): void => {
      buf += decoder.write(chunk);
      if (buf.length > MAX_LINE * 2) buf = buf.slice(-MAX_LINE); // bound a no-newline flood
      for (;;) {
        const nl = buf.indexOf("\n");
        if (nl < 0) break;
        let line = buf.slice(0, nl).replace(/\r$/, "").trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        if (line.length > MAX_LINE) line = line.slice(0, MAX_LINE);
        // Approval replies / `/approvals` are handled here at the line event — NOT
        // enqueued as a model turn — so they resolve even while the turn is parked
        // on the very approval they answer. Everything else flows as a user turn.
        try {
          if (opts.onPaneControl?.(line)) continue;
        } catch {
          // a control handler error must never drop the operator's line silently
        }
        // Shed pane load when the merge queue is saturated. Steering rows are
        // already DB-capped by the dispatcher; the pane is the unbounded source.
        if (queue.length >= MAX_QUEUE) continue;
        push({ body: line, source: "pane", sender: null, steeringId: null });
      }
    };
    const onErr = (): void => {}; // ignore pane read errors
    const onEnd = (): void => {}; // detached pane EOF — do NOT end the session
    opts.stdin.on("data", onData);
    opts.stdin.on("error", onErr);
    opts.stdin.on("end", onEnd);
    if (typeof opts.stdin.resume === "function") opts.stdin.resume();
    detachStdin = (): void => {
      opts.stdin?.off("data", onData);
      opts.stdin?.off("error", onErr);
      opts.stdin?.off("end", onEnd);
    };
  }

  // Steering inbox producer (poll, de-duped).
  const poller = (async (): Promise<void> => {
    while (!stopped) {
      try {
        const rows = opts.steeringRows();
        const queuedIds = new Set(rows.map((r) => r.id));
        for (const id of pushed) if (!queuedIds.has(id)) pushed.delete(id); // prune consumed
        for (const row of rows) {
          if (pushed.has(row.id)) continue;
          pushed.add(row.id);
          push({ body: row.body, source: row.source, sender: row.sender, steeringId: row.id });
        }
      } catch {
        // store closed during shutdown — stop polling
        break;
      }
      await sleep(opts.pollMs);
    }
  })();

  const onAbort = (): void => {
    stopped = true;
    queue.length = 0; // drop undelivered turns on interrupt/shutdown — steering rows
    // stay 'queued' in the DB (re-emitted by a fresh runner); pane lines are ephemeral.
    nudge();
  };
  if (opts.signal) opts.signal.addEventListener("abort", onAbort, { once: true });

  try {
    for (;;) {
      if (stopped) return; // checked BEFORE draining, so abort stops promptly
      if (queue.length > 0) {
        yield queue.shift()!;
        continue;
      }
      // Park until a producer pushes OR pollMs elapses. The bounded wait is what
      // lets a consumer's return()/abort be honored within pollMs — an unbounded
      // park would leave stdin listeners + the poll timer alive on close, because
      // an async generator's return() cannot preempt an unresolved await.
      await new Promise<void>((resolve) => {
        const fire = (): void => {
          wake = null;
          clearTimeout(timer);
          resolve();
        };
        wake = fire;
        const timer = setTimeout(fire, opts.pollMs);
      });
    }
  } finally {
    stopped = true;
    detachStdin();
    if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
    await poller.catch(() => {});
  }
}
