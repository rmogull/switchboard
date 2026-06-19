import { readFileSync } from "node:fs";

import type { SwitchboardConfig } from "../../config/schema.js";
import type { Logger } from "../../core/logger.js";
import { expandHome } from "../../core/paths.js";
import { IronCurtainWsClient } from "./ws-client.js";
import type { IcEndpoint, IcEvent, IcRpcResult } from "./ws-client.js";

type IcConfig = SwitchboardConfig["ironcurtain"];

/** A sandboxed session as the IronCurtain web-UI reports it (subset we use). */
export interface IcSessionDto {
  readonly label: number;
  readonly status: string;
  readonly persona?: string;
}

/** A pending escalation pushed by the IronCurtain web-UI (subset we use). */
export interface IcEscalationDto {
  readonly escalationId: string;
  readonly sessionLabel: number;
  readonly serverName: string;
  readonly toolName: string;
  readonly arguments: Record<string, unknown>;
  readonly reason: string;
}

export type IcDecision = "approved" | "denied";

/**
 * Typed wrapper over the IronCurtain web-UI WS surface: the calls Switchboard
 * actually uses (create/send/end/list sessions; subscribe to + resolve
 * escalations). One connected client per IronCurtain daemon.
 */
export class IronCurtainClient {
  private readonly ws: IronCurtainWsClient;

  constructor(
    endpoint: IcEndpoint,
    private readonly log: Logger,
  ) {
    this.ws = new IronCurtainWsClient(endpoint, { requestTimeoutMs: 30_000, connectTimeoutMs: 10_000 });
  }

  /** Resolve the endpoint from config: an explicit `endpoint` wins, else parse the state file. */
  static discover(cfg: IcConfig): IcEndpoint | undefined {
    if (cfg.endpoint) return cfg.endpoint;
    let raw: string;
    try {
      raw = readFileSync(expandHome(cfg.stateFile), "utf-8");
    } catch {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }
    if (parsed === null || typeof parsed !== "object") return undefined;
    const v = parsed as Record<string, unknown>;
    if (typeof v.host !== "string" || typeof v.port !== "number" || typeof v.token !== "string") {
      return undefined;
    }
    return { host: v.host, port: v.port, token: v.token };
  }

  connect(): Promise<void> {
    return this.ws.connect();
  }

  close(): Promise<void> {
    return this.ws.close();
  }

  /** Fires once on an involuntary disconnect (never on a deliberate close()). */
  onClose(fn: (reason: string) => void): () => void {
    return this.ws.onClose((i) => fn(i.reason));
  }

  /** Subscribe to `escalation.created` events. Returns an unsubscribe. */
  onEscalation(fn: (dto: IcEscalationDto) => void): () => void {
    return this.ws.onEvent((e: IcEvent) => {
      if (e.event === "escalation.created") fn(e.payload as IcEscalationDto);
    });
  }

  /** Subscribe to `session.ended` events (payload carries the integer label). */
  onSessionEnded(fn: (label: number) => void): () => void {
    return this.ws.onEvent((e: IcEvent) => {
      if (e.event !== "session.ended") return;
      const p = e.payload as { label?: unknown };
      if (typeof p.label === "number") fn(p.label);
    });
  }

  /** A `status` ping — true if the daemon answered. */
  async status(): Promise<boolean> {
    const r = await this.ws.call("status");
    return r.ok;
  }

  /** A `status` ping that also returns the daemon's reported payload (IronCurtain's shape; read defensively). */
  async statusReport(): Promise<{ ok: boolean; payload: unknown }> {
    const r = await this.ws.call("status");
    return { ok: r.ok, payload: r.ok ? r.payload : undefined };
  }

  /**
   * Create a sandboxed session; returns its integer label. Uses a long timeout
   * (the default ping timeout is far too short) because this RPC cold-starts a
   * Docker container + its MCP servers + the MITM proxy, which can take well over
   * the 30s ping budget on a fresh daemon.
   */
  async createSession(persona?: string): Promise<number> {
    const params: Record<string, unknown> = persona ? { persona } : {};
    const r = await this.ws.call<{ label?: number }>("sessions.create", params, 180_000);
    if (!r.ok) throw new Error(`ic sessions.create failed: ${r.code} ${r.message}`);
    const label = r.payload?.label;
    if (typeof label !== "number") throw new Error("ic sessions.create returned no label");
    return label;
  }

  async send(label: number, text: string): Promise<void> {
    const r = await this.ws.call("sessions.send", { label, text });
    if (!r.ok) throw new Error(`ic sessions.send failed: ${r.code} ${r.message}`);
  }

  /** End a session; benign if it is already gone. */
  async end(label: number): Promise<void> {
    const r = await this.ws.call("sessions.end", { label });
    if (!r.ok && r.code !== "SESSION_NOT_FOUND") {
      this.log.warn("ic sessions.end not-ok", { label, code: r.code });
    }
  }

  /** Active session labels (defensive about an array vs `{sessions:[…]}` payload). */
  async listLabels(): Promise<number[]> {
    const r = await this.ws.call<unknown>("sessions.list");
    if (!r.ok) throw new Error(`ic sessions.list failed: ${r.code} ${r.message}`);
    const arr = Array.isArray(r.payload)
      ? r.payload
      : ((r.payload as { sessions?: unknown } | null)?.sessions ?? []);
    if (!Array.isArray(arr)) return [];
    const labels: number[] = [];
    for (const s of arr) {
      const label = (s as { label?: unknown } | null)?.label;
      if (typeof label === "number") labels.push(label);
    }
    return labels;
  }

  /** Pending escalations (defensive about the payload envelope). */
  async listEscalations(): Promise<IcEscalationDto[]> {
    const r = await this.ws.call<unknown>("escalations.list");
    if (!r.ok) return [];
    const arr = Array.isArray(r.payload)
      ? r.payload
      : ((r.payload as { escalations?: unknown } | null)?.escalations ?? []);
    return Array.isArray(arr) ? (arr as IcEscalationDto[]) : [];
  }

  /** Resolve an escalation; the caller inspects the result (NOT_FOUND/EXPIRED are benign). */
  resolve(escalationId: string, decision: IcDecision): Promise<IcRpcResult> {
    return this.ws.call("escalations.resolve", { escalationId, decision });
  }
}
