import type { Database } from "better-sqlite3";
import type { Clock } from "../../core/clock.js";
import type { SteeringRow, SteeringSource, SteeringStatus } from "../types.js";

export interface EnqueueSteering {
  sessionId: string;
  source: SteeringSource;
  sender?: string | null;
  body: string;
}

function mapRow(r: Record<string, unknown>): SteeringRow {
  return {
    id: r.id as number,
    sessionId: r.session_id as string,
    source: r.source as SteeringSource,
    sender: (r.sender as string | null) ?? null,
    body: r.body as string,
    status: r.status as SteeringStatus,
    createdAt: r.created_at as number,
    consumedAt: (r.consumed_at as number | null) ?? null,
  };
}

/**
 * The inbound steering relay (§5.5 bidirectional). The dispatcher enqueues a
 * vetted operator turn; the in-pane streaming runner drains it IN ORDER (the
 * autoincrement id is the total order) and yields each as an SDKUserMessage.
 * `consume` is conditional on still being queued, so a row is claimed exactly
 * once even if the drain loop overlaps a restart.
 */
export class SteeringRepo {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  enqueue(s: EnqueueSteering): SteeringRow {
    const info = this.db
      .prepare(
        `INSERT INTO steering_inbox (session_id, source, sender, body, status, created_at)
         VALUES (@session_id, @source, @sender, @body, 'queued', @created_at)`,
      )
      .run({
        session_id: s.sessionId,
        source: s.source,
        sender: s.sender ?? null,
        body: s.body,
        created_at: this.clock.now(),
      });
    return this.get(Number(info.lastInsertRowid))!;
  }

  get(id: number): SteeringRow | undefined {
    const r = this.db.prepare("SELECT * FROM steering_inbox WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? mapRow(r) : undefined;
  }

  /** Count of still-queued (undelivered) rows for a session — drives backpressure. */
  countQueued(sessionId: string): number {
    const r = this.db
      .prepare("SELECT COUNT(*) AS n FROM steering_inbox WHERE session_id = ? AND status = 'queued'")
      .get(sessionId) as { n: number };
    return r.n;
  }

  /** Queued rows for a session, oldest first (the SDK input order). */
  listQueued(sessionId: string): SteeringRow[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM steering_inbox WHERE session_id = ? AND status = 'queued' ORDER BY id ASC",
      )
      .all(sessionId);
    return (rows as Record<string, unknown>[]).map(mapRow);
  }

  /** Claim a queued row. Returns true if THIS call consumed it (idempotent). */
  consume(id: number): boolean {
    const info = this.db
      .prepare(
        `UPDATE steering_inbox
           SET status = 'consumed', consumed_at = @now
         WHERE id = @id AND status = 'queued'`,
      )
      .run({ id, now: this.clock.now() });
    return info.changes === 1;
  }
}
