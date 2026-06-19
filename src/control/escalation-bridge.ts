/**
 * Escalation bridge (plan §2.B) — the seam that makes a Docker-sandboxed
 * IronCurtain agent's tool escalations ride Switchboard's EXISTING approval →
 * Signal path, with the same fail-close guarantees as every native session.
 *
 * Direction in:  IronCurtain `escalation.created` → `approvals.create()` (a normal
 *   pending approval row, tagged `source:"ironcurtain"`). `ApprovalNotifier`'s own
 *   poll then pushes the y/n prompt to Signal — the bridge does NOT send it.
 * Direction out: the bridge polls ITS OWN approval rows leaving `pending` (exactly
 *   as `ApprovalNotifier` polls `listPendingUnnotified`, because `approvals.decide()`
 *   emits no event) and relays the decision back via `escalations.resolve`. The
 *   sandbox tool runs only after the operator approves.
 *
 * Authority stays where it already is: Signal / dashboard / policy_auto own the
 * DECISION (`approvals.decide`); the bridge only creates the request and relays the
 * recorded outcome. A dashboard-side and Signal-side decision can never double-
 * resolve because both go through the single conditional `decide()` write.
 *
 * Fail-close (Invariant 7): a tracked escalation is denied (`timeout`/`policy_auto`)
 * the moment its session ends, the WS drops, or the daemon becomes unreachable —
 * because nothing in Switchboard waits on an IronCurtain session, the bridge is the
 * only thing that can deny a stranded sandbox escalation.
 */
import { randomUUID } from "node:crypto";

import type { Logger } from "../core/logger.js";
import type { Store } from "../state/db.js";
import type { IronCurtainDaemon } from "../execution/ironcurtain/daemon.js";
import type { IcDecision, IcEscalationDto, IronCurtainClient } from "../execution/ironcurtain/client.js";
import type {
  DecideResult,
  IcEscalationView,
  IcSessionDigest,
  IcSessionView,
  IronCurtainBridge,
} from "./ironcurtain-bridge.js";

const POLL_MS = 1500;

/** Marker that ties an approval row back to the IronCurtain escalation that raised it. */
const IC_SOURCE = "ironcurtain";

interface TrackedEscalation {
  readonly approvalId: string;
  readonly label: number;
}

/** Parse the `{"label":N,"persona":"…"}` IronCurtain handle persisted on a session row. */
function parseHandle(backendHandle: string | null): { label?: number; persona?: string } {
  if (!backendHandle) return {};
  try {
    const h = JSON.parse(backendHandle) as { label?: unknown; persona?: unknown };
    return {
      ...(typeof h.label === "number" ? { label: h.label } : {}),
      ...(typeof h.persona === "string" ? { persona: h.persona } : {}),
    };
  } catch {
    return {};
  }
}

function safeParse(s: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export class EscalationBridge implements IronCurtainBridge {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private wiredClient: IronCurtainClient | undefined;
  private unwireFns: Array<() => void> = [];
  /** escalationId → tracked approval. The bridge's authoritative in-flight map. */
  private readonly track = new Map<string, TrackedEscalation>();
  /** escalationId dedupe — a created OR already-decided escalation is never re-ingested. */
  private readonly seen = new Set<string>();

  constructor(
    private readonly store: Store,
    private readonly ic: IronCurtainDaemon,
    private readonly log: Logger,
    private readonly pollMs = POLL_MS,
  ) {}

  /** Rehydrate from the approvals table (restart durability), then start the poll. */
  start(): void {
    this.rehydrate();
    this.timer = setInterval(() => {
      this.tick().catch((e) => this.log.warn("escalation bridge tick failed", { err: String(e) }));
    }, this.pollMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.unwire();
    this.wiredClient = undefined;
  }

  /**
   * Rebuild `track`/`seen` from persisted IronCurtain approval rows so a Switchboard
   * restart doesn't orphan the return path (the escalationId is persisted inside
   * request_json). Pending rows are re-tracked (their decision still relays out);
   * already-decided rows are only marked seen (never re-ingested).
   */
  private rehydrate(): void {
    let pending = 0;
    for (const a of this.store.approvals.listPending()) {
      const req = safeParse(a.requestJson);
      if (req?.source !== IC_SOURCE) continue;
      const escId = req.escalationId;
      const label = req.sessionLabel;
      if (typeof escId !== "string") continue;
      this.seen.add(escId);
      if (typeof label === "number") {
        this.track.set(escId, { approvalId: a.id, label });
        pending++;
      }
    }
    if (pending) this.log.info("escalation bridge rehydrated", { pending });
  }

  // ---- poll loop -----------------------------------------------------------

  /** One poll cycle. Public (like ApprovalNotifier.tick) so tests can drive it. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      let client = this.ic.client;
      // Reattach to a still-running daemon after a Switchboard restart / WS drop —
      // but only when we have a reason to (tracked escalations or live sandbox rows),
      // so an idle daemon-less Switchboard never attempts a connect every tick.
      if (!client && (this.track.size > 0 || this.hasActiveIcSessions())) {
        client = (await this.ic.adopt()) ?? undefined;
      }
      if (!client) {
        // Daemon unreachable: fail-close every stranded escalation (the WS onClose
        // may never have fired — e.g. across a Switchboard restart with a dead daemon).
        if (this.track.size > 0) {
          for (const escId of [...this.track.keys()]) {
            this.failCloseEscalation(escId, "ironcurtain daemon unreachable");
          }
        }
        this.unwire();
        this.wiredClient = undefined;
        return;
      }
      if (client !== this.wiredClient) this.attach(client);
      // Backstop the push events: re-list current escalations so a push missed
      // during the attach window is still ingested (dedupe makes this idempotent).
      const live = await client.listEscalations().catch(() => null);
      if (live) for (const dto of live) this.onEscalationCreated(dto);
      await this.pollDecisions(client);
    } finally {
      this.running = false;
    }
  }

  /** Relay any decided tracked escalations back to IronCurtain, then forget them. */
  private async pollDecisions(client: IronCurtainClient): Promise<void> {
    for (const [escId, t] of [...this.track]) {
      const a = this.store.approvals.get(t.approvalId);
      if (!a) {
        // The approval row vanished (e.g. retention) — nothing to relay; drop it.
        this.track.delete(escId);
        continue;
      }
      if (a.status === "pending") continue;
      // approved → approved; denied/timeout → denied (fail-closed).
      const decision: IcDecision = a.status === "approved" ? "approved" : "denied";
      const r = await client.resolve(escId, decision);
      if (!r.ok) {
        // ESCALATION_NOT_FOUND / EXPIRED are benign (IC already moved on).
        this.log.warn("ic escalation resolve not-ok", { escId, code: r.code, decision });
      }
      this.track.delete(escId);
    }
  }

  // ---- inbound: escalation.created → approval row --------------------------

  private onEscalationCreated(dto: IcEscalationDto): void {
    if (typeof dto?.escalationId !== "string" || typeof dto?.sessionLabel !== "number") return;
    if (this.seen.has(dto.escalationId)) return; // dedupe (push + poll + redelivery)
    const sessionId = this.resolveApprovalSessionId(dto.sessionLabel);
    const approvalId = randomUUID();
    // Force every bridged escalation HIGH-BLAST: the `mcp__` prefix makes
    // isHighBlast() true, so a bare `y` can never resolve it — the operator must
    // confirm with the explicit short id (the async circuit-breaker), and the
    // Signal prompt shows the fuller request detail. A sandbox tool reaching the
    // network / writing files deserves that ceremony.
    const toolName = `mcp__ironcurtain__${dto.serverName}__${dto.toolName}`;
    try {
      this.store.approvals.create({
        id: approvalId,
        sessionId,
        toolName,
        request: {
          source: IC_SOURCE,
          escalationId: dto.escalationId,
          sessionLabel: dto.sessionLabel,
          server: dto.serverName,
          tool: dto.toolName,
          arguments: dto.arguments,
          reason: dto.reason,
        },
      });
    } catch (err) {
      // FK or transient failure — leave it UNSEEN so the next tick's backstop retries.
      this.log.warn("ic escalation approval create failed; will retry", {
        escId: dto.escalationId,
        err: String(err),
      });
      return;
    }
    this.store.audit.append({
      type: "approval_request",
      source: "dispatcher",
      sessionId,
      payload: { id: approvalId, source: IC_SOURCE, escalationId: dto.escalationId, tool: toolName },
    });
    this.track.set(dto.escalationId, { approvalId, label: dto.sessionLabel });
    this.seen.add(dto.escalationId);
  }

  /**
   * FK target for the approval row. Prefer the REAL sandboxed session row (the one
   * `spawnIronCurtain` created, matched by its persisted label) so the approval is
   * correctly attributed and the dashboard shows no duplicate. Only when no live
   * sandbox row owns this label (e.g. an escalation from a daemon Switchboard
   * adopted but didn't spawn) do we insert a synthetic `ic-s{label}` row to satisfy
   * the approvals→sessions FK.
   */
  private resolveApprovalSessionId(label: number): string {
    const real = this.store.sessions
      .list({ active: true })
      .find((s) => s.backend === "ironcurtain" && parseHandle(s.backendHandle).label === label);
    if (real) return real.id;

    const synthId = `ic-s${label}`;
    if (!this.store.sessions.get(synthId)) {
      this.store.sessions.create({
        id: synthId,
        client: "claude",
        mode: "interactive",
        workingDir: "(ironcurtain sandbox)",
        tmuxTarget: null,
        status: "running",
        backend: "ironcurtain",
      });
      this.store.sessions.setIronCurtainHandle(synthId, label);
    }
    return synthId;
  }

  // ---- fail-close ----------------------------------------------------------

  /**
   * Deny a tracked escalation locally (timeout/policy_auto) and best-effort tell
   * IronCurtain. Idempotent: `decide()` is a no-op if the row was already resolved,
   * so a Signal decision that landed first is never clobbered.
   */
  private failCloseEscalation(escId: string, reason: string, client?: IronCurtainClient): void {
    const t = this.track.get(escId);
    if (!t) return;
    this.track.delete(escId);
    const a = this.store.approvals.get(t.approvalId);
    if (this.store.approvals.decide(t.approvalId, "timeout", "policy_auto")) {
      this.store.audit.append({
        type: "approval_decision",
        source: "dispatcher",
        sessionId: a?.sessionId ?? null,
        payload: { id: t.approvalId, status: "timeout", via: "policy_auto", reason, escalationId: escId },
      });
    }
    // The daemon/session is going away; this is best-effort and usually NOT_FOUND.
    if (client) client.resolve(escId, "denied").catch(() => {});
  }

  private onSessionEnded(label: number, client?: IronCurtainClient): void {
    for (const [escId, t] of [...this.track]) {
      if (t.label === label) this.failCloseEscalation(escId, "ironcurtain session ended", client);
    }
  }

  private onClose(reason: string): void {
    // Involuntary WS disconnect (the vendored client fires onClose ONLY then, never
    // on a deliberate close()): deny everything in flight. No client to relay to.
    for (const escId of [...this.track.keys()]) {
      this.failCloseEscalation(escId, `ironcurtain connection lost: ${reason}`);
    }
    this.unwire();
    this.wiredClient = undefined;
  }

  // ---- client wiring -------------------------------------------------------

  private attach(client: IronCurtainClient): void {
    this.unwire();
    this.wiredClient = client;
    this.unwireFns.push(client.onEscalation((dto) => this.onEscalationCreated(dto)));
    this.unwireFns.push(client.onSessionEnded((label) => this.onSessionEnded(label, client)));
    this.unwireFns.push(client.onClose((reason) => this.onClose(reason)));
  }

  private unwire(): void {
    for (const fn of this.unwireFns) {
      try {
        fn();
      } catch {
        /* ignore */
      }
    }
    this.unwireFns = [];
  }

  private hasActiveIcSessions(): boolean {
    return this.store.sessions.list({ active: true }).some((s) => s.backend === "ironcurtain");
  }

  // ---- IronCurtainBridge (dashboard read/decide surface) -------------------

  enabled(): boolean {
    return true;
  }

  listSessions(): IcSessionView[] {
    const pending = this.pendingBySession();
    return this.store.sessions
      .list()
      .filter((s) => s.backend === "ironcurtain")
      .map((s) => {
        const h = parseHandle(s.backendHandle);
        return {
          id: s.id,
          label: h.label ?? null,
          persona: h.persona ?? null,
          status: s.status,
          workingDir: s.workingDir,
          escalationsPending: pending.get(s.id) ?? 0,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
        };
      });
  }

  listEscalations(): IcEscalationView[] {
    const out: IcEscalationView[] = [];
    for (const a of this.store.approvals.listPending()) {
      const req = safeParse(a.requestJson);
      if (req?.source !== IC_SOURCE) continue;
      out.push({
        approvalId: a.id,
        escalationId: typeof req.escalationId === "string" ? req.escalationId : "",
        sessionId: a.sessionId,
        sessionLabel: typeof req.sessionLabel === "number" ? req.sessionLabel : null,
        server: typeof req.server === "string" ? req.server : "",
        tool: typeof req.tool === "string" ? req.tool : a.toolName,
        reason: typeof req.reason === "string" ? req.reason : "",
        arguments: req.arguments ?? null,
        status: a.status,
        requestedAt: a.requestedAt,
      });
    }
    return out;
  }

  sessionDigest(id: string): IcSessionDigest | undefined {
    const s = this.store.sessions.get(id);
    if (!s || s.backend !== "ironcurtain") return undefined;
    const h = parseHandle(s.backendHandle);
    const escs = this.listEscalations().filter((e) => e.sessionId === id);
    const lines: string[] = [
      `session ${s.id}` + (h.persona ? ` · persona ${h.persona}` : ""),
      `status: ${s.status}` + (h.label != null ? ` · ironcurtain label ${h.label}` : ""),
      "",
      escs.length ? "pending escalations:" : "no pending escalations.",
      ...escs.map((e) => `  • ${e.server}/${e.tool} — ${e.reason}`),
      "",
      "Live agent output is in the IronCurtain web-UI; this digest reflects Switchboard's view.",
    ];
    return { id: s.id, label: h.label ?? null, digest: lines.join("\n") };
  }

  decideEscalation(approvalId: string, decision: IcDecision): DecideResult {
    if (decision !== "approved" && decision !== "denied") {
      return { ok: false, error: "decision must be approved|denied" };
    }
    const a = this.store.approvals.get(approvalId);
    if (!a) return { ok: false, error: "no such approval" };
    const req = safeParse(a.requestJson);
    if (req?.source !== IC_SOURCE) return { ok: false, error: "not an ironcurtain escalation" };
    const ok = this.store.approvals.decide(approvalId, decision, "dashboard");
    // The WS resolve back to IronCurtain is relayed by pollDecisions on the next
    // tick — never inline, so the dashboard request never blocks on the daemon.
    return ok ? { ok: true } : { ok: false, error: "already decided" };
  }

  private pendingBySession(): Map<string, number> {
    const m = new Map<string, number>();
    for (const e of this.listEscalations()) {
      m.set(e.sessionId, (m.get(e.sessionId) ?? 0) + 1);
    }
    return m;
  }
}
