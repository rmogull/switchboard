import { rmSync } from "node:fs";
import { join } from "node:path";

import type { Logger } from "../core/logger.js";
import type { Store } from "../state/db.js";

const DAY_MS = 86_400_000;

export interface RetentionOptions {
  /** Purge terminal sessions older than this many days. <= 0 disables retention. */
  sessionDays: number;
  /** State dir holding the per-session scratch (`scratch/<id>`) + task (`sessions/<id>`) dirs. */
  stateDir: string;
  /** Injectable clock (tests). */
  now?: () => number;
}

/**
 * Ages out old sessions for hygiene + a tight security footprint (§ data
 * minimization). Purges TERMINAL sessions (done/failed/killed) older than
 * `sessionDays` — their DB rows (session + approvals/steering/outbound/transcript/
 * proposals) AND their on-disk scratch/task dirs — while PRESERVING the append-only
 * audit_log, which keeps a `retention_purge` record of each removal (so the
 * security audit reflects what existed and that it was aged out). Active sessions
 * are never touched. Runs in the daemon; a no-op when disabled (sessionDays <= 0).
 */
export class RetentionService {
  private readonly now: () => number;

  constructor(
    private readonly store: Store,
    private readonly opts: RetentionOptions,
    private readonly log: Logger,
  ) {
    this.now = opts.now ?? (() => Date.now());
  }

  /** Purge every terminal session that ended more than `sessionDays` ago. Returns the count purged. */
  sweep(): number {
    if (this.opts.sessionDays <= 0) return 0; // retention disabled
    const cutoff = this.now() - this.opts.sessionDays * DAY_MS;
    const stale = this.store.sessions.listTerminalEndedBefore(cutoff);
    let purged = 0;
    for (const s of stale) {
      try {
        const ageDays = Math.floor((this.now() - (s.endedAt ?? s.updatedAt)) / DAY_MS);
        // DB purge (atomic, audited). Then the filesystem state — ONLY the isolated
        // scratch/task dirs under stateDir, NEVER the session's working_dir (which
        // may be a real repo). rmSync force:true no-ops when a dir doesn't exist.
        this.store.purgeSession(s.id, { status: s.status, backend: s.backend, ageDays });
        this.removeDir(join(this.opts.stateDir, "scratch", s.id));
        this.removeDir(join(this.opts.stateDir, "sessions", s.id));
        purged++;
      } catch (e) {
        this.log.warn("retention purge failed for session", { id: s.id, err: String(e) });
      }
    }
    if (purged > 0) {
      this.log.info("retention swept stale sessions", { purged, sessionDays: this.opts.sessionDays });
    }
    return purged;
  }

  private removeDir(dir: string): void {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      this.log.warn("retention dir removal failed", { dir, err: String(e) });
    }
  }
}
