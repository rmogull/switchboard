import type { Database } from "better-sqlite3";
import type { Clock } from "../../core/clock.js";
import type { AuditRow, AuditType } from "../types.js";

export interface AuditAppend {
  type: AuditType;
  source: string; // AuditSource string; widened for ergonomics at call sites
  sessionId?: string | null;
  coordinationId?: string | null;
  payload?: unknown;
}

function mapRow(r: Record<string, unknown>): AuditRow {
  return {
    id: r.id as number,
    ts: r.ts as number,
    type: r.type as AuditType,
    sessionId: (r.session_id as string | null) ?? null,
    coordinationId: (r.coordination_id as string | null) ?? null,
    source: r.source as string,
    payloadJson: (r.payload_json as string | null) ?? null,
  };
}

/**
 * Append-only audit log (Invariant 6). This repo exposes NO update or delete —
 * the only mutation is `append`, and the database triggers reject anything else.
 * The log is never read back as instruction; it is evidence, not control flow.
 */
export class AuditRepo {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  /** Record one event. Returns the new row id (used as a FK by coordination_plans). */
  append(e: AuditAppend): number {
    const info = this.db
      .prepare(
        `INSERT INTO audit_log (ts, type, session_id, coordination_id, source, payload_json)
         VALUES (@ts, @type, @session_id, @coordination_id, @source, @payload_json)`,
      )
      .run({
        ts: this.clock.now(),
        type: e.type,
        session_id: e.sessionId ?? null,
        coordination_id: e.coordinationId ?? null,
        source: e.source,
        payload_json: e.payload === undefined ? null : JSON.stringify(e.payload),
      });
    return Number(info.lastInsertRowid);
  }

  get(id: number): AuditRow | undefined {
    const r = this.db.prepare("SELECT * FROM audit_log WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? mapRow(r) : undefined;
  }

  /** Most recent events first, optionally scoped to a session. */
  recent(opts: { sessionId?: string; limit?: number } = {}): AuditRow[] {
    const limit = opts.limit ?? 100;
    const rows = opts.sessionId
      ? this.db
          .prepare(
            "SELECT * FROM audit_log WHERE session_id = ? ORDER BY id DESC LIMIT ?",
          )
          .all(opts.sessionId, limit)
      : this.db.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?").all(limit);
    return (rows as Record<string, unknown>[]).map(mapRow);
  }
}
