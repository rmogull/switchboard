/**
 * Minimal JSON-RPC-over-WebSocket client for the IronCurtain daemon web-UI
 * surface (`ws://host:port/ws?token=`). Uses node's built-in global `WebSocket`
 * (node 22+), so Switchboard needs no `ws` dependency.
 *
 * Wire contract (mirrors IronCurtain's own daemon-client):
 *   request  {id, method, params}
 *   response {id, ok:true, payload} | {id, ok:false, error:{code,message,data}}
 *   event    {event, payload, seq}            (unsolicited; no id)
 *
 * Invariants:
 *  - `call()` is id-correlated; an RPC-level error resolves `{ok:false}` (callers
 *    branch on the discriminant). Transport failures (not connected, timeout) reject.
 *  - `onClose()` fires AT MOST ONCE and ONLY for an INVOLUNTARY disconnect. A
 *    deliberate `close()` does NOT fire it — this is what lets the escalation
 *    bridge distinguish "the IronCurtain daemon went away" (fail-close) from "we
 *    tore down on purpose" (shutdown).
 */

export interface IcEndpoint {
  readonly host: string;
  readonly port: number;
  readonly token: string;
}

export type IcRpcResult<T = unknown> =
  | { readonly ok: true; readonly payload: T }
  | { readonly ok: false; readonly code: string; readonly message: string; readonly data?: unknown };

export interface IcEvent {
  readonly event: string;
  readonly payload: unknown;
  readonly seq: number;
}

export interface IcCloseInfo {
  readonly code?: number;
  readonly reason: string;
}

export interface IcWsOptions {
  readonly requestTimeoutMs?: number;
  readonly connectTimeoutMs?: number;
}

interface PendingCall {
  readonly resolve: (r: IcRpcResult) => void;
  readonly reject: (e: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class IronCurtainWsClient {
  private ws: WebSocket | undefined;
  private readonly pending = new Map<string, PendingCall>();
  private readonly eventListeners = new Set<(e: IcEvent) => void>();
  private readonly closeListeners = new Set<(i: IcCloseInfo) => void>();
  private idc = 0;
  private closed = false;
  private closeNotified = false;
  private lastError: Error | undefined;

  constructor(
    private readonly endpoint: IcEndpoint,
    private readonly opts: IcWsOptions = {},
  ) {}

  connect(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("ic ws client is closed"));
    if (this.ws) return Promise.reject(new Error("ic ws client already connected"));
    const url = `ws://${this.endpoint.host}:${this.endpoint.port}/ws?token=${this.endpoint.token}`;
    const ws = new WebSocket(url);
    this.ws = ws;
    const connectTimeoutMs = this.opts.connectTimeoutMs ?? 10_000;
    return new Promise<void>((resolve, reject) => {
      const detach = (): void => {
        ws.removeEventListener("open", onOpen);
        ws.removeEventListener("error", onError);
      };
      const onOpen = (): void => {
        clearTimeout(timer);
        detach();
        this.attach(ws);
        resolve();
      };
      const onError = (): void => {
        clearTimeout(timer);
        detach();
        if (this.ws === ws) this.ws = undefined;
        const err = new Error("ic ws connect error");
        this.lastError = err;
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        reject(err);
      };
      const timer = setTimeout(() => {
        detach();
        if (this.ws === ws) this.ws = undefined;
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        reject(new Error(`ic ws connect timed out after ${connectTimeoutMs}ms`));
      }, connectTimeoutMs);
      ws.addEventListener("open", onOpen);
      ws.addEventListener("error", onError);
    });
  }

  /**
   * Issue an id-correlated RPC. `timeoutMs` overrides the client default for this
   * one call — required because `sessions.create` boots a Docker container (tens of
   * seconds, cold) while `status`/`list` are sub-second pings that must NOT inherit
   * a long timeout (a hung ping would otherwise stall the heartbeat).
   */
  call<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<IcRpcResult<T>> {
    if (this.closed) return Promise.reject(new Error("ic ws client is closed"));
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("ic ws client is not connected"));
    }
    const id = `sb-${++this.idc}`;
    const requestTimeoutMs = timeoutMs ?? this.opts.requestTimeoutMs ?? 30_000;
    return new Promise<IcRpcResult<T>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ic rpc "${method}" (${id}) timed out after ${requestTimeoutMs}ms`));
      }, requestTimeoutMs);
      this.pending.set(id, { resolve: resolve as (r: IcRpcResult) => void, reject, timer });
      try {
        ws.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  onEvent(listener: (e: IcEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  onClose(listener: (i: IcCloseInfo) => void): () => void {
    this.closeListeners.add(listener);
    return () => {
      this.closeListeners.delete(listener);
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("ic ws client closed"));
    }
    this.pending.clear();
    this.eventListeners.clear();
    this.closeListeners.clear();
    const ws = this.ws;
    if (!ws || ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      ws.addEventListener("close", () => resolve(), { once: true });
      try {
        ws.close();
      } catch {
        resolve();
      }
    });
  }

  private attach(ws: WebSocket): void {
    ws.addEventListener("message", (ev) => this.onFrame(ev.data));
    // A permanent capturer so a deferred post-handshake error has a home and its
    // message survives into the onClose info.
    ws.addEventListener("error", () => {
      this.lastError = new Error("ic ws transport error");
    });
    ws.addEventListener("close", (ev) => this.onWsClose(typeof ev.code === "number" ? ev.code : undefined));
  }

  private onFrame(data: unknown): void {
    let frame: Record<string, unknown>;
    try {
      const raw = typeof data === "string" ? data : String(data);
      frame = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof frame.id === "string") {
      const p = this.pending.get(frame.id);
      if (!p) return;
      this.pending.delete(frame.id);
      clearTimeout(p.timer);
      p.resolve(toResult(frame));
      return;
    }
    if (typeof frame.event === "string") {
      const e: IcEvent = {
        event: frame.event,
        payload: frame.payload,
        seq: typeof frame.seq === "number" ? frame.seq : 0,
      };
      for (const listener of this.eventListeners) {
        try {
          listener(e);
        } catch {
          /* a bad listener must not break delivery to the others */
        }
      }
    }
  }

  private onWsClose(code: number | undefined): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("ic ws connection closed"));
    }
    this.pending.clear();
    if (this.closed || this.closeNotified) return;
    this.closeNotified = true;
    const info: IcCloseInfo = {
      ...(code !== undefined ? { code } : {}),
      reason: this.lastError?.message ?? `ic ws closed${code !== undefined ? ` (code ${code})` : ""}`,
    };
    for (const listener of this.closeListeners) {
      try {
        listener(info);
      } catch {
        /* ignore */
      }
    }
  }
}

function toResult(frame: Record<string, unknown>): IcRpcResult {
  if (frame.ok === true) return { ok: true, payload: frame.payload };
  const error = frame.error as { code?: unknown; message?: unknown; data?: unknown } | undefined;
  return {
    ok: false,
    code: typeof error?.code === "string" ? error.code : "INTERNAL_ERROR",
    message: typeof error?.message === "string" ? error.message : "unknown rpc error",
    ...(error?.data !== undefined ? { data: error.data } : {}),
  };
}
