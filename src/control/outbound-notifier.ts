import type { Logger } from "../core/logger.js";
import type { Store } from "../state/db.js";
import type { SignalControlPlane } from "./signal.js";

/**
 * Relays queued outbound session digests (status + final result) to the operator
 * over Signal (§5.5 bidirectional). Runs in the daemon, polling the durable
 * session_outbound queue the in-pane runner writes to. A digest is marked sent
 * ONLY after a successful send, so a transport failure is retried and the queue
 * survives a daemon restart (the row stays 'queued').
 */
export class OutboundNotifier {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(
    private readonly store: Store,
    private readonly signal: SignalControlPlane,
    private readonly log: Logger,
    private readonly pollMs = 1500,
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      this.tick().catch((e) => this.log.warn("outbound notifier tick failed", { err: String(e) }));
    }, this.pollMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    // Non-overlapping guard: a row stays 'queued' while an `await notify()` is in
    // flight, so without this an overlapping tick would re-send it. Same race the
    // approval notifier guards against.
    if (this.running) return;
    this.running = true;
    try {
      for (const o of this.store.outbound.listQueued()) {
        try {
          await this.signal.notify(o.body);
          this.store.outbound.markSent(o.id);
        } catch (e) {
          this.log.warn("outbound relay failed; will retry next tick", { id: o.id, err: String(e) });
        }
      }
    } finally {
      this.running = false;
    }
  }
}
