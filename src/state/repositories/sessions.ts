import type { Database } from "better-sqlite3";
import type { Clock } from "../../core/clock.js";
import type {
  Archetype,
  Client,
  Role,
  SessionBackend,
  SessionRow,
  SessionStatus,
} from "../types.js";

export interface CreateSession {
  id: string;
  client: Client;
  mode: Archetype;
  role?: Role | null;
  workingDir: string;
  tmuxTarget?: string | null;
  coordinationId?: string | null;
  egressAllowlist?: string[] | null;
  status?: SessionStatus;
  backend?: SessionBackend | null;
}

function mapRow(r: Record<string, unknown>): SessionRow {
  const egress = r.egress_allowlist as string | null;
  return {
    id: r.id as string,
    client: r.client as Client,
    mode: r.mode as Archetype,
    role: (r.role as Role | null) ?? null,
    workingDir: r.working_dir as string,
    tmuxTarget: (r.tmux_target as string | null) ?? null,
    status: r.status as SessionStatus,
    coordinationId: (r.coordination_id as string | null) ?? null,
    egressAllowlist: egress ? (JSON.parse(egress) as string[]) : null,
    summary: (r.summary as string | null) ?? null,
    backend: (r.backend as SessionBackend | null) ?? null,
    claudeSessionId: (r.claude_session_id as string | null) ?? null,
    externalSessionId: (r.external_session_id as string | null) ?? null,
    backendHandle: (r.backend_handle as string | null) ?? null,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
    endedAt: (r.ended_at as number | null) ?? null,
  };
}

/** Terminal states a session can never transition out of. */
const TERMINAL: ReadonlySet<SessionStatus> = new Set([
  "done",
  "failed",
  "killed",
]);

export class SessionRepo {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  create(s: CreateSession): SessionRow {
    const now = this.clock.now();
    this.db
      .prepare(
        `INSERT INTO sessions
           (id, client, mode, role, working_dir, tmux_target, status,
            coordination_id, egress_allowlist, summary, backend, claude_session_id,
            external_session_id, backend_handle,
            created_at, updated_at, ended_at)
         VALUES
           (@id, @client, @mode, @role, @working_dir, @tmux_target, @status,
            @coordination_id, @egress_allowlist, NULL, @backend, NULL,
            NULL, NULL,
            @created_at, @updated_at, NULL)`,
      )
      .run({
        id: s.id,
        client: s.client,
        mode: s.mode,
        role: s.role ?? null,
        working_dir: s.workingDir,
        tmux_target: s.tmuxTarget ?? null,
        status: s.status ?? "starting",
        coordination_id: s.coordinationId ?? null,
        egress_allowlist: s.egressAllowlist ? JSON.stringify(s.egressAllowlist) : null,
        backend: s.backend ?? null,
        created_at: now,
        updated_at: now,
      });
    return this.get(s.id)!;
  }

  /** Reopen a (failed) session as running on resume — clears the stale ended_at. */
  reopenRunning(id: string): void {
    this.db
      .prepare("UPDATE sessions SET status = 'running', updated_at = ?, ended_at = NULL WHERE id = ?")
      .run(this.clock.now(), id);
  }

  /** Persist the SDK session id captured from the runner's first system message. */
  setClaudeSessionId(id: string, claudeSessionId: string): void {
    this.db
      .prepare("UPDATE sessions SET claude_session_id = ?, updated_at = ? WHERE id = ?")
      .run(claudeSessionId, this.clock.now(), id);
  }

  get(id: string): SessionRow | undefined {
    const r = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? mapRow(r) : undefined;
  }

  list(opts: { status?: SessionStatus; active?: boolean } = {}): SessionRow[] {
    let rows: unknown[];
    if (opts.status) {
      rows = this.db
        .prepare("SELECT * FROM sessions WHERE status = ? ORDER BY created_at DESC")
        .all(opts.status);
    } else if (opts.active) {
      rows = this.db
        .prepare(
          "SELECT * FROM sessions WHERE status NOT IN ('done','failed','killed') ORDER BY created_at DESC",
        )
        .all();
    } else {
      rows = this.db.prepare("SELECT * FROM sessions ORDER BY created_at DESC").all();
    }
    return (rows as Record<string, unknown>[]).map(mapRow);
  }

  /**
   * Terminal sessions (done/failed/killed) that ended before `cutoff` — the input
   * to retention. Legacy rows without ended_at fall back to updated_at so they age
   * too. Active sessions are never returned, regardless of age.
   */
  listTerminalEndedBefore(cutoff: number): SessionRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM sessions
          WHERE status IN ('done','failed','killed')
            AND COALESCE(ended_at, updated_at) < ?
          ORDER BY COALESCE(ended_at, updated_at) ASC`,
      )
      .all(cutoff);
    return (rows as Record<string, unknown>[]).map(mapRow);
  }

  /** Update status; stamps updated_at, and ended_at when entering a terminal state. */
  setStatus(id: string, status: SessionStatus): void {
    const now = this.clock.now();
    const ended = TERMINAL.has(status) ? now : null;
    this.db
      .prepare(
        `UPDATE sessions
           SET status = @status,
               updated_at = @now,
               ended_at = COALESCE(@ended, ended_at)
         WHERE id = @id`,
      )
      .run({ id, status, now, ended });
  }

  setTmuxTarget(id: string, tmuxTarget: string): void {
    this.db
      .prepare("UPDATE sessions SET tmux_target = ?, updated_at = ? WHERE id = ?")
      .run(tmuxTarget, this.clock.now(), id);
  }

  /** Change the executor backend (e.g. on convert: claude_sdk_stream → claude_cli_console). */
  setBackend(id: string, backend: SessionBackend): void {
    this.db
      .prepare("UPDATE sessions SET backend = ?, updated_at = ? WHERE id = ?")
      .run(backend, this.clock.now(), id);
  }

  /**
   * Persist the IronCurtain web-session handle. The web-UI surface identifies a
   * session only by a per-process integer `label` (there is no durable UUID),
   * stored here as `{"label":N}` JSON. Labels are valid only within one
   * IronCurtain daemon lifetime — IC web sessions do not survive a daemon restart
   * — so reconcile fails any active sandboxed row whose label is absent from
   * `sessions.list` (and all of them when the daemon is down). `external_session_id`
   * stays reserved for a future durable id. The optional `persona` is stored
   * alongside the label so the dashboard's Sandboxed tab can show which profile
   * governs the session (resume is rejected for ironcurtain, so it is display-only).
   */
  setIronCurtainHandle(id: string, label: number, persona?: string): void {
    const handle = persona ? { label, persona } : { label };
    this.db
      .prepare("UPDATE sessions SET backend_handle = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(handle), this.clock.now(), id);
  }

  setSummary(id: string, summary: string): void {
    this.db
      .prepare("UPDATE sessions SET summary = ?, updated_at = ? WHERE id = ?")
      .run(summary, this.clock.now(), id);
  }
}
