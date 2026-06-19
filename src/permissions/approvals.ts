import { uuid } from "../core/ids.js";
import type { Store } from "../state/db.js";
import type { ApprovalRow, ApprovalScope, ApprovalStatus, DecidedVia } from "../state/types.js";

export interface ApprovalRequest {
  sessionId: string;
  toolName: string;
  request: unknown;
  /** Aborted when the SDK turn is interrupted — releases a parked approval (denied). */
  signal?: AbortSignal;
}

export interface ApprovalOutcome {
  approved: boolean;
  status: ApprovalStatus;
  via: DecidedVia | null;
  /** `session` when the operator chose to approve this tool for the whole session. */
  scope: ApprovalScope;
}

export interface ApprovalGatewayOptions {
  /** How long a blocking tool call waits for an out-of-band decision (§5.5). */
  timeoutMs?: number;
  /** Poll interval against the approvals table. */
  pollMs?: number;
  /**
   * Invoked the moment an approval is created, so a transport (the daemon's
   * Signal notifier, the dashboard) can push the prompt immediately rather than
   * waiting to discover it by polling.
   */
  onRequest?: (approval: ApprovalRow) => void;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Sleep, but resolve early if the signal aborts — so an interrupt is noticed promptly. */
function sleepOrAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return sleep(ms);
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const onAbort = (): void => {
      clearTimeout(t);
      resolve();
    };
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * The async approval round-trip (§5.5). A blocking `ask` decision creates a
 * pending approval and waits for it to be resolved — by a Signal reply, the
 * dashboard, or the timeout. Decisions arrive in a DIFFERENT process (the
 * daemon's Signal handler) than the one waiting here (the session runner), so
 * the bridge is the approvals table: this side polls, the decider writes.
 *
 * Fail closed: an unanswered approval times out to a deny (Invariant 7).
 */
export class ApprovalGateway {
  private readonly timeoutMs: number;
  private readonly pollMs: number;
  private readonly onRequest: ((a: ApprovalRow) => void) | undefined;

  constructor(
    private readonly store: Store,
    opts: ApprovalGatewayOptions = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.pollMs = opts.pollMs ?? 500;
    this.onRequest = opts.onRequest;
  }

  async requestDecision(req: ApprovalRequest): Promise<ApprovalOutcome> {
    const id = uuid();
    const row = this.store.approvals.create({
      id,
      sessionId: req.sessionId,
      toolName: req.toolName,
      request: req.request,
    });
    this.store.audit.append({
      type: "approval_request",
      sessionId: req.sessionId,
      source: "policy",
      payload: { id, toolName: req.toolName, request: req.request },
    });
    this.onRequest?.(row);

    // Wall-clock deadline (independent of the store's injected clock).
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      const a = this.store.approvals.get(id);
      if (a && a.status !== "pending") {
        this.store.audit.append({
          type: "approval_decision",
          sessionId: req.sessionId,
          source: "policy",
          payload: { id, status: a.status, via: a.decidedVia },
        });
        return { approved: a.status === "approved", status: a.status, via: a.decidedVia, scope: a.scope };
      }
      if (req.signal?.aborted) {
        // The operator interrupted the turn — release this parked approval as a
        // deny (an interrupted tool must not run). Honor any real decision that
        // won the row first (same TOCTOU guard as the timeout path).
        const decidedByUs = this.store.approvals.decide(id, "denied", "policy_auto");
        if (!decidedByUs) {
          const cur = this.store.approvals.get(id);
          if (cur && cur.status !== "pending") {
            this.store.audit.append({
              type: "approval_decision",
              sessionId: req.sessionId,
              source: "policy",
              payload: { id, status: cur.status, via: cur.decidedVia },
            });
            return { approved: cur.status === "approved", status: cur.status, via: cur.decidedVia, scope: cur.scope };
          }
        }
        this.store.audit.append({
          type: "approval_decision",
          sessionId: req.sessionId,
          source: "policy",
          payload: { id, status: "denied", via: "policy_auto", reason: "interrupted" },
        });
        return { approved: false, status: "denied", via: "policy_auto", scope: "once" };
      }
      if (Date.now() >= deadline) {
        const decidedByUs = this.store.approvals.decide(id, "timeout", "policy_auto");
        if (!decidedByUs) {
          // A real decision (Signal/dashboard/pane) won the conditional UPDATE
          // between our last poll and this deadline check. Honor that outcome
          // rather than reporting a spurious timeout-deny.
          const a = this.store.approvals.get(id);
          if (a && a.status !== "pending") {
            this.store.audit.append({
              type: "approval_decision",
              sessionId: req.sessionId,
              source: "policy",
              payload: { id, status: a.status, via: a.decidedVia },
            });
            return { approved: a.status === "approved", status: a.status, via: a.decidedVia, scope: a.scope };
          }
        }
        this.store.audit.append({
          type: "approval_decision",
          sessionId: req.sessionId,
          source: "policy",
          payload: { id, status: "timeout", via: "policy_auto" },
        });
        return { approved: false, status: "timeout", via: "policy_auto", scope: "once" };
      }
      await sleepOrAbort(this.pollMs, req.signal);
    }
  }
}
