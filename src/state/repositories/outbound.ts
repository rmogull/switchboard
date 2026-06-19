import type { Database } from "better-sqlite3";
import type { Clock } from "../../core/clock.js";
import type { OutboundKind, OutboundRow, OutboundStatus } from "../types.js";

export interface EnqueueOutbound {
  sessionId: string;
  kind: OutboundKind;
  body: string;
}

function mapRow(r: Record<string, unknown>): OutboundRow {
  return {
    id: r.id as number,
    sessionId: r.session_id as string,
    kind: r.kind as OutboundKind,
    body: r.body as string,
    status: r.status as OutboundStatus,
    createdAt: r.created_at as number,
    sentAt: (r.sent_at as number | null) ?? null,
  };
}

/**
 * The outbound digest queue (the verbosity-split chokepoint). The streaming
 * runner enqueues only status + final-result digests; the daemon relays them to
 * Signal and marks each sent ONLY after a successful send, so a transport
 * failure is retried instead of lost (and the row survives a daemon restart).
 */
export class OutboundRepo {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  enqueue(o: EnqueueOutbound): OutboundRow {
    const info = this.db
      .prepare(
        `INSERT INTO session_outbound (session_id, kind, body, status, created_at)
         VALUES (@session_id, @kind, @body, 'queued', @created_at)`,
      )
      .run({ session_id: o.sessionId, kind: o.kind, body: o.body, created_at: this.clock.now() });
    return this.get(Number(info.lastInsertRowid))!;
  }

  get(id: number): OutboundRow | undefined {
    const r = this.db.prepare("SELECT * FROM session_outbound WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? mapRow(r) : undefined;
  }

  /** Queued digests across all sessions, oldest first. */
  listQueued(): OutboundRow[] {
    const rows = this.db
      .prepare("SELECT * FROM session_outbound WHERE status = 'queued' ORDER BY id ASC")
      .all();
    return (rows as Record<string, unknown>[]).map(mapRow);
  }

  /** Mark a digest sent. Returns true if THIS call marked it (idempotent). */
  markSent(id: number): boolean {
    const info = this.db
      .prepare(
        `UPDATE session_outbound
           SET status = 'sent', sent_at = @now
         WHERE id = @id AND status = 'queued'`,
      )
      .run({ id, now: this.clock.now() });
    return info.changes === 1;
  }
}
