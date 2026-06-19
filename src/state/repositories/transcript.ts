import type { Database } from "better-sqlite3";
import type { Clock } from "../../core/clock.js";
import type { TranscriptKind, TranscriptRow, TranscriptSource } from "../types.js";

export interface AppendTranscript {
  sessionId: string;
  kind: TranscriptKind;
  source: TranscriptSource;
  text: string;
}

/** Per-row text cap — a single huge model response must not create a giant SQLite
 * row or bloat the dashboard JSON. The full output remains in the pane. */
const MAX_TEXT = 64_000;

function mapRow(r: Record<string, unknown>): TranscriptRow {
  return {
    seq: r.seq as number,
    sessionId: r.session_id as string,
    ts: r.ts as number,
    kind: r.kind as TranscriptKind,
    source: r.source as TranscriptSource,
    text: r.text as string,
  };
}

/**
 * Append-only conversation transcript (Inc3). The streaming runner appends; the
 * dashboard reads (by cursor or recent tail). Transcript text is display DATA —
 * never fed back as a steering turn or command (Invariant 4).
 */
export class TranscriptRepo {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  append(t: AppendTranscript): TranscriptRow {
    const text = t.text.length > MAX_TEXT ? `${t.text.slice(0, MAX_TEXT)} …(truncated)` : t.text;
    const info = this.db
      .prepare(
        `INSERT INTO transcript (session_id, ts, kind, source, text)
         VALUES (@session_id, @ts, @kind, @source, @text)`,
      )
      .run({ session_id: t.sessionId, ts: this.clock.now(), kind: t.kind, source: t.source, text });
    return this.get(Number(info.lastInsertRowid))!;
  }

  get(seq: number): TranscriptRow | undefined {
    const r = this.db.prepare("SELECT * FROM transcript WHERE seq = ?").get(seq) as
      | Record<string, unknown>
      | undefined;
    return r ? mapRow(r) : undefined;
  }

  /** Rows after a cursor (for incremental dashboard polling). */
  listAfter(sessionId: string, afterSeq: number, limit = 500): TranscriptRow[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM transcript WHERE session_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?",
      )
      .all(sessionId, afterSeq, Math.max(1, Math.min(limit, 2000)));
    return (rows as Record<string, unknown>[]).map(mapRow);
  }

  /** The most recent `limit` rows for a session, in chronological order (for the log view). */
  listRecent(sessionId: string, limit = 300): TranscriptRow[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM (SELECT * FROM transcript WHERE session_id = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq ASC",
      )
      .all(sessionId, Math.max(1, Math.min(limit, 2000)));
    return (rows as Record<string, unknown>[]).map(mapRow);
  }
}
