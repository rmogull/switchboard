/**
 * Read/decide surface the dashboard's Sandboxed tab depends on, decoupled from the
 * WS escalation bridge that implements it. Keeping this a narrow interface lets the
 * dashboard be constructed with a `NullIronCurtainBridge` (everything empty) when
 * the IronCurtain backend is disabled or not yet wired, so the dashboard degrades
 * gracefully and the existing call sites compile unchanged.
 *
 * The live `EscalationBridge` (src/control/escalation-bridge.ts) implements this —
 * it already holds the session/escalation state the tab renders, and routes a
 * dashboard decision through the SAME `approvals.decide` path as a Signal reply, so
 * the two surfaces can never double-resolve one escalation.
 */
import type { IcDecision } from "../execution/ironcurtain/client.js";

/** A sandboxed session as the Sandboxed tab renders it. */
export interface IcSessionView {
  readonly id: string;
  readonly label: number | null;
  readonly persona: string | null;
  readonly status: string;
  readonly workingDir: string;
  /** Count of still-pending bridged escalations for this session. */
  readonly escalationsPending: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** A bridged escalation (one pending sandbox tool-use awaiting an operator decision). */
export interface IcEscalationView {
  /** The Switchboard approval id — the decide key (mirrors a native approval). */
  readonly approvalId: string;
  readonly escalationId: string;
  readonly sessionId: string;
  readonly sessionLabel: number | null;
  readonly server: string;
  readonly tool: string;
  readonly reason: string;
  readonly arguments: unknown;
  readonly status: string;
  readonly requestedAt: number;
}

export interface DecideResult {
  readonly ok: boolean;
  /** Present when ok is false (e.g. already-decided, or not an IronCurtain approval). */
  readonly error?: string;
}

export interface IcSessionDigest {
  readonly id: string;
  readonly label: number | null;
  readonly digest: string;
}

/**
 * The dashboard's view of the IronCurtain backend. All methods are synchronous
 * reads off already-collected state except the (cheap) decide write — the
 * dashboard must never block its request loop on a WS round-trip.
 */
export interface IronCurtainBridge {
  /** True when the IronCurtain backend is enabled (controls tab visibility). */
  enabled(): boolean;
  /** Sandboxed sessions to render in the Sandboxed tab. */
  listSessions(): IcSessionView[];
  /** Pending bridged escalations awaiting an operator decision. */
  listEscalations(): IcEscalationView[];
  /** A read-only digest for one sandboxed session (status + escalation history). */
  sessionDigest(id: string): IcSessionDigest | undefined;
  /**
   * Decide a bridged escalation by its Switchboard approval id. Routes through
   * `approvals.decide` (resolve-exactly-once), so a Signal-side and dashboard-side
   * decision race cannot double-resolve. The WS resolve back to IronCurtain happens
   * on the bridge's own poll — never inline here.
   */
  decideEscalation(approvalId: string, decision: IcDecision): DecideResult;
}

/** Inert bridge used when the IronCurtain backend is off or not wired. */
export class NullIronCurtainBridge implements IronCurtainBridge {
  enabled(): boolean {
    return false;
  }
  listSessions(): IcSessionView[] {
    return [];
  }
  listEscalations(): IcEscalationView[] {
    return [];
  }
  sessionDigest(): IcSessionDigest | undefined {
    return undefined;
  }
  decideEscalation(): DecideResult {
    return { ok: false, error: "ironcurtain backend is not enabled" };
  }
}
