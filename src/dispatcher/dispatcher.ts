import type { ResolvedConfig } from "../config/index.js";
import type { Logger } from "../core/logger.js";
import type { SessionRow } from "../state/types.js";
import type { Store } from "../state/db.js";
import type { IncomingMessage, SignalControlPlane } from "../control/signal.js";
import { type ApprovalNotifier, parseApprovalReply } from "../control/approval-notifier.js";
import { sessionIdFromQuotedText } from "../control/signal-digest.js";
import type { SpawnRequest } from "../execution/session.js";
import { canonicalPlan } from "../coordination/plan.js";
import type { CoordinateArgs, Coordinator } from "../coordination/coordinator.js";
import type { LearningService } from "../learning/service.js";
import { classifyCommand, type ClassifiedCommand } from "./classify.js";

/** Max undelivered steering turns queued for one session before we shed load. */
const MAX_QUEUED_STEERING = 200;

/** The session-spawning surface the dispatcher needs (SessionManager satisfies it). */
export interface Spawner {
  spawn(req: SpawnRequest): Promise<SessionRow>;
  attachCommand(id: string): string;
  resume?(id: string): Promise<SessionRow>;
  convertToNative?(id: string, opts: { remoteControl?: boolean }): Promise<SessionRow>;
}

/**
 * The dispatcher (§5.1) — privileged but narrow. It turns a vetted Signal
 * message into exactly one action: apply an approval reply, or classify and
 * spawn a session. It NEVER re-interprets a message as a new command stream and
 * NEVER itself performs consequential work — that happens in scoped child
 * sessions (Invariant 3).
 */
export class Dispatcher {
  constructor(
    private readonly deps: {
      sessions: Spawner;
      signal: SignalControlPlane;
      notifier: ApprovalNotifier;
      cfg: ResolvedConfig;
      log: Logger;
      store?: Store;
      coordinator?: Coordinator;
      learning?: LearningService;
    },
  ) {}

  async handle(msg: IncomingMessage): Promise<void> {
    // A message addressed to a LIVE streaming session (`@<id> ...`) is a steering
    // turn (DATA) for that session — routed FIRST, before approval-reply/learning/
    // classify, so a steering 'yes' can never resolve an unrelated approval and so
    // it never spawns a new session.
    if (await this.handleSteering(msg)) return;

    // A Signal REPLY (swipe-to-reply) to a session's digest continues THAT session
    // instead of spawning a new one — the natural way to keep talking to a session
    // without typing `@<id>`. Checked before approval/classify so the quote's target
    // decides intent; a reply to an approval PROMPT still falls through to the
    // approval path below.
    if (await this.handleQuotedSteering(msg)) return;

    // An approval reply (y/n) takes precedence over treating the text as a command.
    if (await this.deps.notifier.handleReply(msg.text)) return;

    // Learning-loop commands (explicit confirmation of auto-allow suggestions).
    if (this.deps.learning && (await this.handleLearning(msg.text))) return;

    // `resume <id>` — operator-gated crash recovery of a streaming session.
    if (await this.handleResume(msg.text)) return;

    // `cli <id>` / `convert <id> [phone]` — convert a gated streaming session into a
    // native full-CLI session (continue anywhere), deliberately accepting looser perms.
    if (await this.handleConvert(msg.text)) return;

    const c = classifyCommand(msg.text, { repos: this.deps.cfg.repos });

    if (c.archetype === "coordinated" && this.deps.coordinator && this.deps.store) {
      return this.handleCoordinated(c);
    }

    const req: SpawnRequest = { client: c.client, mode: c.archetype, task: c.task };
    if (c.repo) req.repo = c.repo;
    if (c.workingDir) req.workingDir = c.workingDir;
    if (c.dirHint) req.dirHint = c.dirHint;
    if (c.egressAllowlist) req.egressAllowlist = c.egressAllowlist;
    if (c.control) req.control = c.control;
    if (c.persona) req.persona = c.persona;

    try {
      const s = await this.deps.sessions.spawn(req);
      // Surface any auto-parsed egress allowlist so the operator sees exactly
      // which domains this session may reach without prompting.
      const egress = c.egressAllowlist?.length ? `\negress allowed: ${c.egressAllowlist.join(", ")}` : "";
      // Tell the operator which directory it landed in — and flag a scratch fallback
      // when a named project couldn't be found.
      const scratchFallback = c.dirHint && !s.workingDir.includes(c.dirHint);
      const dirLine = `\ndir: ${s.workingDir}${scratchFallback ? ` (couldn't find '${c.dirHint}' — using scratch)` : ""}`;
      // Sandboxed (IronCurtain) sessions have no attachable tmux pane — attachCommand
      // throws for them; surface the Sandboxed-tab hint instead so the spawn doesn't
      // get misreported as a failure.
      const reach =
        s.backend === "ironcurtain"
          ? "sandboxed session — view it in the dashboard's Sandboxed tab"
          : `attach: ${this.deps.sessions.attachCommand(s.id)}`;
      await this.deps.signal.notify(
        `spawned ${s.id} (${s.client}/${s.mode}${s.role ? `, ${s.role}` : ""})${dirLine}${egress}\n${reach}`,
      );
    } catch (err) {
      this.deps.log.error("spawn from command failed", { err: String(err) });
      await this.deps.signal.notify(`couldn't start that: ${String(err)}`);
    }
  }

  /**
   * Route a `@<id> <text>` message addressed to a LIVE streaming session: the
   * text is enqueued onto that session's steering_inbox as DATA (a model
   * user-turn) — NEVER executed as a Switchboard command and never via tmux
   * send-keys (Invariant 4). Returns true if the message was a steering message
   * (handled). A non-streaming or unknown target is reported, not silently
   * relayed. Requires the store (always present in the daemon).
   */
  private async handleSteering(msg: IncomingMessage): Promise<boolean> {
    const store = this.deps.store;
    if (!store) return false;
    const m = msg.text.match(/^@(\S+)\s+([\s\S]+)$/);
    if (!m) return false;
    const id = m[1]!;
    const body = m[2]!.trim();
    if (!body) return false;

    const s = store.sessions.get(id);
    const active = s && !["done", "failed", "killed"].includes(s.status);
    if (!s || !active) {
      await this.deps.signal.notify(`@${id}: no live session by that id.`);
      return true;
    }
    if (s.backend !== "claude_sdk_stream") {
      await this.deps.signal.notify(
        `@${id} is a ${s.backend ?? s.mode} session, not a steerable streaming session.`,
      );
      return true;
    }

    return this.routeSteering(id, body, msg);
  }

  /**
   * A Signal swipe-to-reply to a session's digest → steer THAT session. The target
   * id is recovered from the quoted text (Switchboard's digests embed it). Returns
   * true when handled. A reply whose quote is an approval PROMPT and whose text is a
   * y/n is left for the approval path (return false). An unrecognized quote (no real
   * session) is also left alone, so ordinary new commands still spawn as before.
   */
  private async handleQuotedSteering(msg: IncomingMessage): Promise<boolean> {
    const store = this.deps.store;
    if (!store || !msg.quotedText) return false;
    const id = sessionIdFromQuotedText(msg.quotedText);
    if (!id) return false;
    const s = store.sessions.get(id);
    if (!s) return false; // not a known session → fall through to normal handling

    // Reply to an approval prompt with a y/n → that's an approval decision, not
    // steering; let notifier.handleReply own it.
    const quotedApproval = /\bSession\s+\S+\s+wants\b/i.test(msg.quotedText) || /HIGH-RISK/i.test(msg.quotedText);
    if (quotedApproval && parseApprovalReply(msg.text)) return false;

    const body = msg.text.trim();
    if (!body) return false;
    const active = !["done", "failed", "killed"].includes(s.status);
    if (!active) {
      await this.deps.signal.notify(`${id}: that session has ended (${s.status}) — not steering your reply.`);
      return true;
    }
    if (s.backend !== "claude_sdk_stream") {
      await this.deps.signal.notify(`${id} isn't a steerable streaming session — reply ignored.`);
      return true;
    }
    return this.routeSteering(id, body, msg);
  }

  /**
   * Enqueue a vetted operator turn onto a session's steering inbox as DATA (a model
   * user-turn) — NEVER executed as a Switchboard command and never via tmux
   * send-keys (Invariant 4). Backpressure sheds load (rejected-newest with an
   * audited nack) when the queue is saturated. Caller must have validated the
   * session is live and streamable. Always returns true (the message was handled).
   */
  private async routeSteering(id: string, body: string, msg: IncomingMessage): Promise<boolean> {
    const store = this.deps.store!;
    if (store.steering.countQueued(id) >= MAX_QUEUED_STEERING) {
      store.audit.append({
        type: "steering_message",
        source: `signal:${msg.source}`,
        sessionId: id,
        payload: { event: "rejected_backpressure", queued: MAX_QUEUED_STEERING },
      });
      await this.deps.signal.notify(
        `⚠️ ${id}: steering queue full (${MAX_QUEUED_STEERING}) — let it catch up before sending more.`,
      );
      return true;
    }

    store.steering.enqueue({ sessionId: id, source: "signal", sender: msg.source, body });
    store.audit.append({
      type: "steering_message",
      source: `signal:${msg.source}`,
      sessionId: id,
      payload: { event: "received", bytes: body.length },
    });
    await this.deps.signal.notify(`→ ${id}: queued (${body.length} chars)`);
    return true;
  }

  /**
   * `resume <id>` — relaunch a streaming session's runner with SDK resume from its
   * captured claude_session_id. Operator-gated (never automatic): a session that
   * died mid-action is only resurrected on an explicit command.
   */
  private async handleResume(text: string): Promise<boolean> {
    const m = text.trim().match(/^resume\s+(\S+)$/i);
    if (!m) return false;
    const id = m[1]!;
    if (typeof this.deps.sessions.resume !== "function") {
      await this.deps.signal.notify("resume is not supported here.");
      return true;
    }
    try {
      const s = await this.deps.sessions.resume(id);
      await this.deps.signal.notify(`resumed ${s.id}\nattach: ${this.deps.sessions.attachCommand(s.id)}`);
    } catch (e) {
      await this.deps.signal.notify(`couldn't resume ${id}: ${String(e)}`);
    }
    return true;
  }

  /**
   * `cli <id>` / `convert <id> [phone]` — convert a live GATED streaming session into
   * a NATIVE full-CLI session in place (resumes the conversation; unlocks slash
   * commands / `/remote-control`). `phone`/`rc` targets `claude --remote-control`.
   * Operator-gated and a DELIBERATE step down to CLI-handled permissions (audited in
   * SessionManager.convertToNative). Returns true if the message was a convert command.
   */
  private async handleConvert(text: string): Promise<boolean> {
    const m = text.trim().match(/^(?:cli|convert)\s+(\S+)(?:\s+(phone|rc|remote(?:-control)?))?$/i);
    if (!m) return false;
    const id = m[1]!;
    const remoteControl = m[2] != null;
    if (typeof this.deps.sessions.convertToNative !== "function") {
      await this.deps.signal.notify("convert is not supported here.");
      return true;
    }
    try {
      const s = await this.deps.sessions.convertToNative(id, { remoteControl });
      await this.deps.signal.notify(
        `🔓 ${s.id} → full CLI${remoteControl ? " (remote-control)" : ""} — now UNGATED (CLI handles permissions in-TTY).\nattach: ${this.deps.sessions.attachCommand(s.id)}`,
      );
    } catch (e) {
      await this.deps.signal.notify(`couldn't convert ${id}: ${String(e)}`);
    }
    return true;
  }

  /**
   * Handle a learning-loop command: `learn`/`suggestions` lists auto-allow
   * candidates; `promote <id>` confirms one into a learned rule. Returns true if
   * the message was a learning command (and was handled). Promotion is always
   * an explicit operator confirmation — never automatic (no silent drift).
   */
  private async handleLearning(text: string): Promise<boolean> {
    const learning = this.deps.learning!;
    const t = text.trim();
    if (/^(learn|suggestions)$/i.test(t)) {
      const candidates = learning.candidates();
      await this.deps.signal.notify(
        candidates.length
          ? `auto-allow candidates:\n${candidates.map((c) => `${c.id}: ${c.description}`).join("\n")}\nreply 'promote <id>' to confirm.`
          : "no auto-allow candidates yet.",
      );
      return true;
    }
    const m = t.match(/^promote\s+([a-f0-9]{4,8})$/i);
    if (m) {
      try {
        const r = learning.promote(m[1]!.toLowerCase(), "signal");
        await this.deps.signal.notify(`promoted auto-allow: [${r.kind}] ${r.scope} (rule ${r.id}).`);
      } catch (e) {
        await this.deps.signal.notify(`couldn't promote: ${String(e)}`);
      }
      return true;
    }
    return false;
  }

  /**
   * Coordinated task (§7.3): plan the topology, echo it for visibility, then run
   * the deterministic FSM to convergence in deliverable mode (notify on done,
   * not blocking the message loop). Only the decider lands; provenance is logged.
   */
  private async handleCoordinated(c: ClassifiedCommand): Promise<void> {
    const store = this.deps.store!;
    const coordinator = this.deps.coordinator!;
    const plan = canonicalPlan();
    const auditId = store.audit.append({ type: "command", source: "dispatcher", payload: { coordinated: true, task: c.task } });
    await this.deps.signal.notify(
      `coordinating: ${plan.participants.map((p) => `${p.label}(${p.client})`).join(" → ")}, decider=${plan.decider}. running to convergence…`,
    );
    const args: CoordinateArgs = { task: c.task, commandAuditId: auditId, plan };
    if (c.repo) args.repo = c.repo;
    // Deliverable-mode: don't block the message loop; notify on convergence.
    void coordinator
      .run(args)
      .then((r) =>
        this.deps.signal.notify(
          r.accepted
            ? `✅ coordinated ${r.coordinationId}: ACCEPTED after ${r.iterations} round(s)` +
              (r.landedBranch ? ` — committed to branch ${r.landedBranch} (merge when ready).` : " & landed.") +
              ` ${r.decisionReasoning}`
            : `⚠️ coordinated ${r.coordinationId}: not accepted after ${r.iterations} round(s); changes discarded.`,
        ),
      )
      .catch((e) => {
        this.deps.log.error("coordination failed", { err: String(e) });
        return this.deps.signal.notify(`coordination failed: ${String(e)}`);
      });
  }
}
