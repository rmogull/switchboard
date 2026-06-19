import type { Logger } from "../core/logger.js";
import type { Store } from "../state/db.js";
import type { ApprovalRow } from "../state/types.js";
import type { SignalControlPlane } from "./signal.js";

export interface ParsedApprovalReply {
  approve: boolean;
  /** True for an explicit "approve for the rest of the session" reply (`ya`/`always`). */
  session: boolean;
  idPrefix?: string;
}

/** Pure: is this message an approval reply, and what does it decide? */
export function parseApprovalReply(text: string): ParsedApprovalReply | null {
  // Tolerate surrounding quotes / trailing punctuation an operator's phone keyboard
  // (or copying a quoted prompt example) may add — e.g. `y 1a2b3c4d'` or `'y 1a2b'`.
  // Without this, such a reply falls through and gets classified as a NEW command.
  const cleaned = text.trim().replace(/^['"`\s]+/, "").replace(/['"`.,!\s]+$/, "");
  // `ya` / `always` mean approve AND remember this tool for the rest of the session.
  const m = cleaned.match(/^(y|yes|n|no|approve|deny|ya|always)(?:\s+([a-f0-9]{4,8}))?$/i);
  if (!m) return null;
  const verb = m[1]!.toLowerCase();
  const approve = verb === "y" || verb === "yes" || verb === "approve" || verb === "ya" || verb === "always";
  const session = verb === "ya" || verb === "always";
  const out: ParsedApprovalReply = { approve, session };
  if (m[2]) out.idPrefix = m[2].toLowerCase();
  return out;
}

export type ResolveApprovalResult = { target: ApprovalRow } | { error: string };

/**
 * Pure: pick which pending approval a parsed reply decides, or return the operator
 * guidance string to send back. Shared by the Signal notifier AND the in-pane
 * handler so both surfaces enforce the SAME safety rules — a bare y/n is only
 * honored for a single low-blast pending approval; everything else requires the
 * explicit short id (the high-blast circuit-breaker, §5.5).
 */
export function resolveApprovalTarget(
  pending: ApprovalRow[],
  parsed: ParsedApprovalReply,
): ResolveApprovalResult {
  if (pending.length === 0) return { error: "no pending approval to decide" };
  if (parsed.idPrefix) {
    const matches = pending.filter((a) => a.id.startsWith(parsed.idPrefix!));
    if (matches.length === 0) return { error: `no pending approval matching id ${parsed.idPrefix}` };
    if (matches.length > 1) {
      return {
        error:
          `id ${parsed.idPrefix} is ambiguous (${matches.length} matches) — use the full 8-char id:\n` +
          matches.map((a) => `${a.id.slice(0, 8)} ${a.toolName}`).join("\n"),
      };
    }
    return { target: matches[0]! };
  }
  // A bare y/n is only safe when there is exactly one pending approval AND it is
  // low-blast. Otherwise require the explicit id so a stray reply can never approve
  // the wrong session's action (confused deputy) or a high-blast tool.
  if (pending.length > 1) {
    return {
      error:
        `${pending.length} pending — reply with the id (e.g. 'y ${pending[0]!.id.slice(0, 8)}'):\n` +
        pending.map((a) => `${a.id.slice(0, 8)} ${a.toolName}`).join("\n"),
    };
  }
  if (isHighBlast(pending[0]!.toolName)) {
    return {
      error: `high-risk tool ${pending[0]!.toolName} — confirm explicitly: 'y ${pending[0]!.id.slice(0, 8)}'`,
    };
  }
  return { target: pending[0]! };
}

/**
 * Format a pending approval as an operator-facing prompt. Shared by the Signal
 * notifier and the in-pane render so the two surfaces show the same content.
 */
export function formatApprovalPrompt(a: ApprovalRow): string {
  const hi = isHighBlast(a.toolName);
  // Content-rich prompt: show MORE of the request for high-blast tools (e.g. the
  // Gmail recipient/subject) so an async approval can actually be judged.
  let detail = "";
  try {
    detail = JSON.stringify(JSON.parse(a.requestJson)).slice(0, hi ? 400 : 180);
  } catch {
    detail = a.requestJson.slice(0, hi ? 400 : 180);
  }
  const head = hi
    ? `⚠️ HIGH-RISK — Session ${a.sessionId} wants ${a.toolName}`
    : `🔐 Session ${a.sessionId} wants ${a.toolName}`;
  const id = a.id.slice(0, 8);
  // No surrounding quotes around the example — a copied/auto-quoted reply like
  // `y abcd1234'` must not break parsing. id is required for high-blast tools.
  // `ya` additionally remembers the tool for the rest of the session.
  const replyHint = hi
    ? `Reply (id required):  y ${id} approve  ·  ya ${id} approve for session  ·  n ${id} deny`
    : `Reply y/n (id ${id})  ·  ya = approve for session`;
  return `${head}\n${detail}\n${replyHint}`;
}

/**
 * High-blast tools: a misfired approval here is catastrophic (data exfiltration
 * or destruction across the operator's integrations), not merely a bad local
 * edit. These are the claude.ai MCP integration tools (Gmail/Drive/Slack/…),
 * which an SDK session inherits even under settingSources:[]. A bare 'y' may NEVER
 * resolve one — the explicit short id is always required (defends the async
 * Signal circuit-breaker against a stray reply / confused-deputy).
 */
export function isHighBlast(toolName: string): boolean {
  return toolName.startsWith("mcp__");
}

/**
 * Bridges pending approvals to the operator over Signal (§5.5). Runs in the
 * daemon. It polls for newly-created pending approvals and pushes a y/n prompt;
 * an operator reply (`y` / `n`, optionally with the short approval id) is applied
 * back to the approvals table, which the waiting session runner observes.
 *
 * Polling (not just the gateway's in-process onRequest) is required because the
 * approval is created in the session-runner process, not here.
 */
export class ApprovalNotifier {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(
    private readonly store: Store,
    private readonly signal: SignalControlPlane,
    private readonly log: Logger,
    private readonly pollMs = 1500,
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      this.tick().catch((e) => this.log.warn("approval notifier tick failed", { err: String(e) }));
    }, this.pollMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Push prompts for any pending approvals not yet announced. */
  async tick(): Promise<void> {
    // Non-overlapping guard: notified_at stays NULL while an `await notify()` is
    // in flight, so without this a second (setInterval) tick would re-read the
    // same row and double-send. Serializing ticks closes that window.
    if (this.running) return;
    this.running = true;
    try {
      for (const a of this.store.approvals.listPendingUnnotified()) {
        try {
          await this.signal.notify(formatApprovalPrompt(a));
          // Persist 'notified' ONLY after a successful send, so a transport
          // failure is retried next tick instead of lost, AND a daemon restart
          // does not re-announce every pending approval (state is in the DB, not
          // in-memory) — BUG B, both halves.
          this.store.approvals.markNotified(a.id);
        } catch (e) {
          this.log.warn("approval notify failed; will retry next tick", {
            id: a.id,
            err: String(e),
          });
        }
      }
    } finally {
      this.running = false;
    }
  }

  /**
   * Interpret a Signal message as an approval reply. Returns true if it was a
   * reply (and was applied), false if it should be treated as a command instead.
   */
  async handleReply(text: string): Promise<boolean> {
    const parsed = parseApprovalReply(text);
    if (!parsed) return false;

    const resolved = resolveApprovalTarget(this.store.approvals.listPending(), parsed);
    if ("error" in resolved) {
      await this.signal.notify(resolved.error);
      return true;
    }
    const target = resolved.target;
    const scope = parsed.approve && parsed.session ? "session" : "once";
    const decided = this.store.approvals.decide(
      target.id,
      parsed.approve ? "approved" : "denied",
      "signal",
      scope,
    );
    const verb = parsed.approve ? (scope === "session" ? "approved (for session)" : "approved") : "denied";
    await this.signal.notify(
      decided ? `recorded ${verb} for ${target.id.slice(0, 8)}` : `already decided ${target.id.slice(0, 8)}`,
    );
    return true;
  }
}
