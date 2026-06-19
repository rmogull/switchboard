import type { Database } from "better-sqlite3";
import type { Clock } from "../../core/clock.js";
import type { ApprovalRow, ApprovalScope, ApprovalStatus, DecidedVia } from "../types.js";

export interface CreateApproval {
  id: string;
  sessionId: string;
  toolName: string;
  request: unknown; // serialized to request_json: proposed action + resolved path/scope
}

function mapRow(r: Record<string, unknown>): ApprovalRow {
  return {
    id: r.id as string,
    sessionId: r.session_id as string,
    toolName: r.tool_name as string,
    requestJson: r.request_json as string,
    status: r.status as ApprovalStatus,
    decidedVia: (r.decided_via as DecidedVia | null) ?? null,
    scope: ((r.scope as ApprovalScope | null) ?? "once") as ApprovalScope,
    requestedAt: r.requested_at as number,
    decidedAt: (r.decided_at as number | null) ?? null,
  };
}

/**
 * Approvals back the async Signal round-trip (§5.5). A request is created
 * `pending`, then resolved exactly once to approved/denied/timeout. The decide
 * write is conditional on still being pending, so a Signal reply and a dashboard
 * click racing each other cannot double-decide.
 */
export class ApprovalRepo {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  create(a: CreateApproval): ApprovalRow {
    this.db
      .prepare(
        `INSERT INTO approvals (id, session_id, tool_name, request_json, status, requested_at)
         VALUES (@id, @session_id, @tool_name, @request_json, 'pending', @requested_at)`,
      )
      .run({
        id: a.id,
        session_id: a.sessionId,
        tool_name: a.toolName,
        request_json: JSON.stringify(a.request),
        requested_at: this.clock.now(),
      });
    return this.get(a.id)!;
  }

  get(id: string): ApprovalRow | undefined {
    const r = this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? mapRow(r) : undefined;
  }

  listPending(): ApprovalRow[] {
    const rows = this.db
      .prepare("SELECT * FROM approvals WHERE status = 'pending' ORDER BY requested_at ASC")
      .all();
    return (rows as Record<string, unknown>[]).map(mapRow);
  }

  /** Pending approvals not yet announced to the operator (survives daemon restart). */
  listPendingUnnotified(): ApprovalRow[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM approvals WHERE status = 'pending' AND notified_at IS NULL ORDER BY requested_at ASC",
      )
      .all();
    return (rows as Record<string, unknown>[]).map(mapRow);
  }

  /** Stamp that the operator has been pushed a prompt for this approval. */
  markNotified(id: string): void {
    this.db
      .prepare("UPDATE approvals SET notified_at = @now WHERE id = @id AND notified_at IS NULL")
      .run({ id, now: this.clock.now() });
  }

  /**
   * Resolve a pending approval. Returns true if THIS call decided it; false if
   * it was already decided (lost the race) or does not exist. Callers use the
   * boolean to avoid acting twice on one approval.
   *
   * `scope` records an explicit "approve this tool for the rest of the session"
   * opt-in (default `once`); the session runner reads it to suppress re-prompts
   * for the same tool. It is only meaningful when approving.
   */
  decide(
    id: string,
    status: Exclude<ApprovalStatus, "pending">,
    via: DecidedVia,
    scope: ApprovalScope = "once",
  ): boolean {
    const info = this.db
      .prepare(
        `UPDATE approvals
           SET status = @status, decided_via = @via, scope = @scope, decided_at = @now
         WHERE id = @id AND status = 'pending'`,
      )
      .run({ id, status, via, scope, now: this.clock.now() });
    return info.changes === 1;
  }
}
