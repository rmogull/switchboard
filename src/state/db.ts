import type DB from "better-sqlite3";

import type { Clock } from "../core/clock.js";
import { systemClock } from "../core/clock.js";
import { openDatabase } from "../core/native-check.js";
import { SCHEMA_SQL } from "./schema-sql.js";
import { AuditRepo } from "./repositories/audit.js";
import { SessionRepo } from "./repositories/sessions.js";
import { ApprovalRepo } from "./repositories/approvals.js";
import { CoordinationRepo } from "./repositories/coordination.js";
import { ProposalRepo } from "./repositories/proposals.js";
import { SteeringRepo } from "./repositories/steering.js";
import { OutboundRepo } from "./repositories/outbound.js";
import { TranscriptRepo } from "./repositories/transcript.js";

export type SqliteDatabase = DB.Database;

/**
 * The state store (spec §5.8). One SQLite file, opened in WAL mode with foreign
 * keys enforced, schema applied idempotently at construction. Holds the typed
 * repositories that are the only sanctioned way to read/write state.
 */
export class Store {
  readonly db: SqliteDatabase;
  readonly audit: AuditRepo;
  readonly sessions: SessionRepo;
  readonly approvals: ApprovalRepo;
  readonly coordination: CoordinationRepo;
  readonly proposals: ProposalRepo;
  readonly steering: SteeringRepo;
  readonly outbound: OutboundRepo;
  readonly transcript: TranscriptRepo;

  constructor(dbPath: string, clock: Clock = systemClock) {
    // Native module loaded lazily at construction (not at import) so an ABI mismatch
    // yields a friendly rebuild remedy via openDatabase rather than a raw crash — see
    // native-check.ts. (require() alone wouldn't surface it; the addon loads here.)
    this.db = openDatabase(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    // Make append-only triggers airtight: with recursive_triggers OFF (the
    // default), `INSERT OR REPLACE` deletes-then-inserts WITHOUT firing the BEFORE
    // DELETE trigger, bypassing the audit_log / transcript append-only guard. ON
    // makes that implicit delete hit the trigger and ABORT.
    this.db.pragma("recursive_triggers = ON");
    this.migrate();

    this.audit = new AuditRepo(this.db, clock);
    this.sessions = new SessionRepo(this.db, clock);
    this.approvals = new ApprovalRepo(this.db, clock);
    this.coordination = new CoordinationRepo(this.db, clock);
    this.proposals = new ProposalRepo(this.db, clock);
    this.steering = new SteeringRepo(this.db, clock);
    this.outbound = new OutboundRepo(this.db, clock);
    this.transcript = new TranscriptRepo(this.db, clock);
  }

  /** Apply the schema. Every statement is idempotent (IF NOT EXISTS). */
  private migrate(): void {
    this.db.exec(SCHEMA_SQL);
    // Additive column migrations for DBs created before these columns existed.
    // SQLite has no "ADD COLUMN IF NOT EXISTS", so we check table_info first.
    this.addColumnIfMissing("sessions", "backend", "TEXT");
    this.addColumnIfMissing("sessions", "claude_session_id", "TEXT");
    this.addColumnIfMissing("sessions", "external_session_id", "TEXT");
    this.addColumnIfMissing("sessions", "backend_handle", "TEXT");
    this.addColumnIfMissing("approvals", "notified_at", "INTEGER");
    this.addColumnIfMissing("approvals", "scope", "TEXT NOT NULL DEFAULT 'once'");
  }

  private addColumnIfMissing(table: string, column: string, decl: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (cols.some((c) => c.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }

  /**
   * Retention purge of a single terminal session: delete its row and all FK
   * children (approvals, steering, outbound, transcript, memory_proposals), and
   * record the purge in the append-only audit_log — atomically. The audit_log
   * itself is NEVER deleted (it is the permanent security record, and has no FK to
   * sessions, so its rows survive the session-row delete).
   *
   * The transcript table is append-only (a BEFORE DELETE trigger aborts deletes to
   * stop tampering during a session's life). Retention is a controlled, trusted
   * maintenance op, so the trigger is dropped and immediately recreated INSIDE the
   * transaction — normal operation never observes it absent, and any failure rolls
   * the whole purge (and the trigger) back.
   */
  purgeSession(id: string, auditPayload: Record<string, unknown> = {}): void {
    const tx = this.db.transaction((sid: string) => {
      // Record the purge first, in the same transaction, so the immutable log
      // always reflects what was aged out (the security-audit guarantee).
      this.audit.append({
        type: "status_change",
        source: "dispatcher",
        sessionId: sid,
        payload: { event: "retention_purge", ...auditPayload },
      });
      this.db.prepare("DELETE FROM approvals WHERE session_id = ?").run(sid);
      this.db.prepare("DELETE FROM steering_inbox WHERE session_id = ?").run(sid);
      this.db.prepare("DELETE FROM session_outbound WHERE session_id = ?").run(sid);
      this.db.prepare("DELETE FROM memory_proposals WHERE session_id = ?").run(sid);
      // Controlled removal of append-only transcript rows (see method doc).
      this.db.exec("DROP TRIGGER IF EXISTS transcript_no_delete");
      try {
        this.db.prepare("DELETE FROM transcript WHERE session_id = ?").run(sid);
      } finally {
        this.db.exec(
          "CREATE TRIGGER IF NOT EXISTS transcript_no_delete BEFORE DELETE ON transcript " +
            "BEGIN SELECT RAISE(ABORT, 'transcript is append-only'); END",
        );
      }
      this.db.prepare("DELETE FROM sessions WHERE id = ?").run(sid);
    });
    tx(id);
  }

  /** Schema version recorded in `schema_meta`. */
  schemaVersion(): string {
    const row = this.db
      .prepare("SELECT value FROM schema_meta WHERE key = 'version'")
      .get() as { value: string } | undefined;
    return row?.value ?? "unknown";
  }

  close(): void {
    this.db.close();
  }
}

/** In-memory store for tests. */
export function memoryStore(clock?: Clock): Store {
  return new Store(":memory:", clock);
}
