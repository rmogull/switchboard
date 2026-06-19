import type { Database } from "better-sqlite3";
import type { Clock } from "../../core/clock.js";
import type {
  MemoryProposalRow,
  ProposalCategory,
  ProposalStatus,
} from "../types.js";

export interface CreateProposal {
  id: string;
  sessionId: string;
  category: ProposalCategory;
  proposedText: string;
  targetFile?: string | null;
}

function mapRow(r: Record<string, unknown>): MemoryProposalRow {
  return {
    id: r.id as string,
    sessionId: r.session_id as string,
    category: r.category as ProposalCategory,
    proposedText: r.proposed_text as string,
    targetFile: (r.target_file as string | null) ?? null,
    status: r.status as ProposalStatus,
    createdAt: r.created_at as number,
    decidedAt: (r.decided_at as number | null) ?? null,
  };
}

/**
 * Memory proposal queue (§5.6, Invariant 5). Child sessions only ever *propose*;
 * the dispatcher (or the operator) promotes. Promotion itself is performed by the
 * dispatcher and audit-logged separately with the source session id — this repo
 * just records the proposal's lifecycle.
 */
export class ProposalRepo {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  create(p: CreateProposal): MemoryProposalRow {
    this.db
      .prepare(
        `INSERT INTO memory_proposals
           (id, session_id, category, proposed_text, target_file, status, created_at)
         VALUES
           (@id, @session_id, @category, @proposed_text, @target_file, 'pending', @created_at)`,
      )
      .run({
        id: p.id,
        session_id: p.sessionId,
        category: p.category,
        proposed_text: p.proposedText,
        target_file: p.targetFile ?? null,
        created_at: this.clock.now(),
      });
    return this.get(p.id)!;
  }

  get(id: string): MemoryProposalRow | undefined {
    const r = this.db
      .prepare("SELECT * FROM memory_proposals WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return r ? mapRow(r) : undefined;
  }

  listPending(): MemoryProposalRow[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM memory_proposals WHERE status = 'pending' ORDER BY created_at ASC",
      )
      .all();
    return (rows as Record<string, unknown>[]).map(mapRow);
  }

  /** Mark decided. Returns true if this call transitioned it from pending. */
  resolve(id: string, status: Exclude<ProposalStatus, "pending">): boolean {
    const info = this.db
      .prepare(
        `UPDATE memory_proposals
           SET status = @status, decided_at = @now
         WHERE id = @id AND status = 'pending'`,
      )
      .run({ id, status, now: this.clock.now() });
    return info.changes === 1;
  }
}
