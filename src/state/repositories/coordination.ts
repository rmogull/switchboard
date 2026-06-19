import type { Database } from "better-sqlite3";
import type { Clock } from "../../core/clock.js";
import type { CoordinationPhase, CoordinationPlanRow } from "../types.js";

export interface CreateCoordinationPlan {
  id: string;
  commandAuditId: number;
  topology: unknown; // validated plan object, serialized to topology_json
  deciderSessionId?: string | null;
  phase?: CoordinationPhase;
}

function mapRow(r: Record<string, unknown>): CoordinationPlanRow {
  return {
    id: r.id as string,
    commandAuditId: r.command_audit_id as number,
    topologyJson: r.topology_json as string,
    deciderSessionId: (r.decider_session_id as string | null) ?? null,
    phase: r.phase as CoordinationPhase,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  };
}

export class CoordinationRepo {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  create(p: CreateCoordinationPlan): CoordinationPlanRow {
    const now = this.clock.now();
    this.db
      .prepare(
        `INSERT INTO coordination_plans
           (id, command_audit_id, topology_json, decider_session_id, phase, created_at, updated_at)
         VALUES
           (@id, @command_audit_id, @topology_json, @decider_session_id, @phase, @now, @now)`,
      )
      .run({
        id: p.id,
        command_audit_id: p.commandAuditId,
        topology_json: JSON.stringify(p.topology),
        decider_session_id: p.deciderSessionId ?? null,
        phase: p.phase ?? "planning",
        now,
      });
    return this.get(p.id)!;
  }

  get(id: string): CoordinationPlanRow | undefined {
    const r = this.db
      .prepare("SELECT * FROM coordination_plans WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return r ? mapRow(r) : undefined;
  }

  /** Most-recently-updated coordination plans (for the dashboard coordination view). */
  recent(limit = 20): CoordinationPlanRow[] {
    const rows = this.db
      .prepare("SELECT * FROM coordination_plans ORDER BY updated_at DESC LIMIT ?")
      .all(limit) as Record<string, unknown>[];
    return rows.map(mapRow);
  }

  setPhase(id: string, phase: CoordinationPhase): void {
    this.db
      .prepare("UPDATE coordination_plans SET phase = ?, updated_at = ? WHERE id = ?")
      .run(phase, this.clock.now(), id);
  }

  setDecider(id: string, deciderSessionId: string): void {
    this.db
      .prepare(
        "UPDATE coordination_plans SET decider_session_id = ?, updated_at = ? WHERE id = ?",
      )
      .run(deciderSessionId, this.clock.now(), id);
  }
}
