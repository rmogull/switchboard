import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

import type { Logger } from "../core/logger.js";
import type { Store } from "../state/db.js";

export interface IncomingMessage {
  source: string; // E.164 sender
  text: string;
  timestamp: number;
  /**
   * Text of the message this one is a reply to (Signal's native quote), if any.
   * Switchboard's outbound digests embed the session id (`💬 <id>: …`), so a reply
   * to one can be routed back to that session as steering — recovered from here.
   */
  quotedText?: string;
}

export type CommandHandler = (msg: IncomingMessage) => void | Promise<void>;

/** Pluggable Signal transport so the control plane is testable without a real number. */
export interface SignalTransport {
  start(onMessage: (m: IncomingMessage) => void): Promise<void>;
  send(recipient: string, text: string): Promise<void>;
  stop(): Promise<void>;
}

// --- mock transport (tests + signal-disabled mode) -------------------------

export class MockSignalTransport implements SignalTransport {
  readonly sent: { recipient: string; text: string }[] = [];
  private onMessage: ((m: IncomingMessage) => void) | undefined;

  async start(onMessage: (m: IncomingMessage) => void): Promise<void> {
    this.onMessage = onMessage;
  }
  async send(recipient: string, text: string): Promise<void> {
    this.sent.push({ recipient, text });
  }
  async stop(): Promise<void> {}

  /** Test/REPL helper: simulate an inbound message (optionally a quoted reply). */
  inject(source: string, text: string, timestamp = 0, quotedText?: string): void {
    const m: IncomingMessage = { source, text, timestamp };
    if (quotedText !== undefined) m.quotedText = quotedText;
    this.onMessage?.(m);
  }
}

// --- real signal-cli transport (JSON-RPC over stdio) -----------------------

/**
 * Parse one line of `signal-cli jsonRpc` output into a message, or null if the
 * line is not an inbound data message. Pure so it is unit-testable without a
 * live signal-cli. Shape:
 *   {"jsonrpc":"2.0","method":"receive","params":{"envelope":{
 *      "source":"+1...","timestamp":123,"dataMessage":{"message":"text"}}}}
 */
export function parseSignalCliLine(line: string): IncomingMessage | null {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  const o = obj as {
    method?: string;
    params?: {
      envelope?: {
        source?: string;
        sourceNumber?: string;
        timestamp?: number;
        dataMessage?: { message?: string; quote?: { text?: string } };
      };
    };
  };
  if (o.method !== "receive") return null;
  const env = o.params?.envelope;
  // signal-cli 0.11+ splits `source` into `sourceNumber`/`sourceUuid`; accept either.
  const source = env?.sourceNumber ?? env?.source;
  const text = env?.dataMessage?.message;
  if (!source || typeof text !== "string") return null;
  const out: IncomingMessage = { source, text, timestamp: env?.timestamp ?? 0 };
  // A swipe-to-reply carries the quoted message's body; keep it so the dispatcher
  // can route a reply back to the session that sent the quoted digest.
  const quotedText = env?.dataMessage?.quote?.text;
  if (typeof quotedText === "string" && quotedText.length > 0) out.quotedText = quotedText;
  return out;
}

export class SignalCliTransport implements SignalTransport {
  private proc: ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private onMessage: ((m: IncomingMessage) => void) | undefined;
  private stopped = false;
  private failures = 0;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly account: string,
    private readonly binPath = "signal-cli",
    private readonly log?: Logger,
  ) {}

  async start(onMessage: (m: IncomingMessage) => void): Promise<void> {
    this.onMessage = onMessage;
    this.spawn();
  }

  /**
   * Spawn signal-cli in jsonRpc mode and AUTO-RESTART it with exponential backoff
   * if it exits — so a transient Signal outage, a server-side throttle, or a
   * dropped websocket recovers on its own without the daemon needing a restart.
   * Backoff resets once a connection has stayed up long enough to be healthy.
   */
  private spawn(): void {
    if (this.stopped) return;
    const startedAt = Date.now();
    const proc = spawn(this.binPath, ["-a", this.account, "jsonRpc"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;

    const rl = createInterface({ input: proc.stdout });
    rl.on("line", (line) => {
      const msg = parseSignalCliLine(line);
      if (msg) this.onMessage?.(msg);
      else if (line.includes('"dataMessage"')) {
        // A real text message we couldn't parse — surfaces envelope-format drift.
        // (Receipts/typing/sync notifications have no dataMessage and are ignored.)
        this.log?.warn("unparsed signal data message", { line: line.slice(0, 300) });
      }
    });
    proc.stderr.on("data", (d: Buffer) => this.log?.debug("signal-cli stderr", { line: d.toString().trim() }));
    proc.on("error", (err) => this.log?.error("signal-cli spawn error", { err: String(err) }));
    proc.on("exit", (code) => {
      const ranMs = Date.now() - startedAt;
      this.failures = ranMs > 30_000 ? 0 : this.failures + 1;
      const backoffMs = Math.min(60_000, 5_000 * 2 ** Math.min(this.failures, 4));
      this.log?.warn("signal-cli exited; restarting", { code, ranMs, failures: this.failures, backoffMs });
      if (!this.stopped) this.restartTimer = setTimeout(() => this.spawn(), backoffMs);
    });
  }

  async send(recipient: string, text: string): Promise<void> {
    if (!this.proc) throw new Error("signal-cli transport not started");
    const req = {
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "send",
      params: { recipient: [recipient], message: text },
    };
    this.proc.stdin.write(JSON.stringify(req) + "\n");
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.proc?.kill("SIGTERM");
    this.proc = undefined;
  }
}

// --- control plane (allowlist enforcement) ---------------------------------

export interface SignalControlConfig {
  account: string | undefined;
  allowlist: string[];
}

/**
 * The Signal control plane (§5.2). Enforces the HARD sender allowlist
 * (Invariant 2): a message from any non-allowlisted sender is audited as
 * `dropped_message` and never parsed or interpreted. Allowlisted messages are
 * audited as `command` and handed to the dispatcher. This is a command channel,
 * not a monitored feed.
 */
export class SignalControlPlane {
  constructor(
    private readonly transport: SignalTransport,
    private readonly cfg: SignalControlConfig,
    private readonly store: Store,
    private readonly log: Logger,
  ) {}

  private allowed(source: string): boolean {
    return this.cfg.allowlist.includes(source);
  }

  async start(handler: CommandHandler): Promise<void> {
    await this.transport.start((m) => {
      if (!this.allowed(m.source)) {
        this.store.audit.append({
          type: "dropped_message",
          source: `signal:${m.source}`,
          payload: { text: m.text.slice(0, 200) },
        });
        this.log.warn("dropped non-allowlisted signal sender", { source: m.source });
        return;
      }
      this.store.audit.append({
        type: "command",
        source: `signal:${m.source}`,
        payload: { text: m.text },
      });
      void Promise.resolve(handler(m)).catch((e) =>
        this.log.error("command handler failed", { err: String(e) }),
      );
    });
  }

  /** Notify the operator(s) — the allowlisted number(s). */
  async notify(text: string): Promise<void> {
    for (const r of this.cfg.allowlist) await this.transport.send(r, text);
  }

  async send(recipient: string, text: string): Promise<void> {
    await this.transport.send(recipient, text);
  }

  async stop(): Promise<void> {
    await this.transport.stop();
  }
}
