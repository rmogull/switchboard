/**
 * Domain types — the executor-understood vocabulary. These mirror the SQL
 * schema in `schema.sql` (spec §6) one-to-one. The string unions ARE the
 * contract: the dispatcher (a model) may compose richer language, but every
 * value must resolve onto one of these before it reaches the executor or the
 * database (Invariant 4: deterministic control flow over tainted output).
 */

export type Client = "claude" | "codex";

export type Archetype = "deliverable" | "interactive" | "coordinated";

/** Coordination role primitives (§5.7). Open model vocabulary resolves to these. */
export type Role = "implementer" | "reviewer" | "decider" | "planner" | "solo";

export type SessionStatus =
  | "starting"
  | "running"
  | "awaiting_input"
  | "awaiting_approval"
  | "done"
  | "failed"
  | "killed";

export type CoordinationPhase =
  | "planning"
  | "implementing"
  | "reviewing"
  | "revising"
  | "deciding"
  | "done"
  | "replanning";

/** Append-only audit event kinds (§5.6, Invariant 6). */
export type AuditType =
  | "command"
  | "spawn"
  | "approval_request"
  | "approval_decision"
  | "tool_use"
  | "drive_write"
  | "memory_promotion"
  | "replan"
  | "status_change"
  | "steering_message"
  | "error"
  | "dropped_message";

/**
 * How a session is executed — determines routing, output transport, and how a
 * vanished pane is interpreted on reconcile (a self-reporting SDK runner that
 * vanished while active crashed; a raw CLI that vanished was exited by the
 * operator). Null on legacy rows created before this column existed.
 *   - claude_sdk         — deliverable/coordinated headless runner (one-shot)
 *   - claude_sdk_stream  — interactive streaming runner (the remote default)
 *   - claude_cli_console — interactive raw `claude` CLI (explicit local console)
 *   - codex_cli          — codex CLI session
 *   - ironcurtain        — sandboxed session on the shared IronCurtain daemon
 *                          (no tmux pane; created and driven over the web-ui WS)
 */
export type SessionBackend =
  | "claude_sdk"
  | "claude_sdk_stream"
  | "claude_cli_console"
  | "codex_cli"
  | "ironcurtain";

/** Provenance prefix for `audit_log.source` and inter-agent artifact handoffs. */
export type AuditSource =
  | `signal:${string}`
  | "dispatcher"
  | `session:${string}`
  | "dashboard"
  | "policy";

export type ApprovalStatus = "pending" | "approved" | "denied" | "timeout";

export type DecidedVia = "signal" | "tty" | "dashboard" | "pane" | "policy_auto";

/**
 * Scope of an approval decision. `once` (the default) authorizes only the single
 * tool-use that asked; `session` is an explicit operator opt-in that auto-allows
 * any later use of the SAME tool for the rest of that session (so a re-used MCP
 * integration isn't re-prompted on every call). `session` is only ever set by an
 * explicit operator action — never by a bare approve.
 */
export type ApprovalScope = "once" | "session";

export type ProposalCategory =
  | "convention"
  | "task_pattern"
  | "feedback"
  | "policy_candidate";

export type ProposalStatus = "pending" | "promoted" | "rejected";

// --- Row shapes (camelCase mapping of the SQL columns) ----------------------

export interface SessionRow {
  id: string;
  client: Client;
  mode: Archetype;
  role: Role | null;
  workingDir: string;
  tmuxTarget: string | null;
  status: SessionStatus;
  coordinationId: string | null;
  egressAllowlist: string[] | null;
  summary: string | null;
  backend: SessionBackend | null;
  claudeSessionId: string | null;
  /** Reserved for a future durable IronCurtain session id; null today (the web-UI exposes only a label). */
  externalSessionId: string | null;
  /** Backend-specific handle JSON, e.g. `{"label":3}` for an IronCurtain WS session. */
  backendHandle: string | null;
  createdAt: number;
  updatedAt: number;
  endedAt: number | null;
}

export type SteeringSource = "signal" | "pane" | "dashboard";
export type SteeringStatus = "queued" | "consumed";

export interface SteeringRow {
  id: number;
  sessionId: string;
  source: SteeringSource;
  sender: string | null;
  body: string;
  status: SteeringStatus;
  createdAt: number;
  consumedAt: number | null;
}

export type OutboundKind = "status" | "result" | "notice";
export type OutboundStatus = "queued" | "sent";

export interface OutboundRow {
  id: number;
  sessionId: string;
  kind: OutboundKind;
  body: string;
  status: OutboundStatus;
  createdAt: number;
  sentAt: number | null;
}

export type TranscriptKind = "user" | "assistant" | "result" | "status";
export type TranscriptSource = "pane" | "signal" | "dashboard" | "model" | "session";

export interface TranscriptRow {
  seq: number;
  sessionId: string;
  ts: number;
  kind: TranscriptKind;
  source: TranscriptSource;
  text: string;
}

export interface CoordinationPlanRow {
  id: string;
  commandAuditId: number;
  topologyJson: string;
  deciderSessionId: string | null;
  phase: CoordinationPhase;
  createdAt: number;
  updatedAt: number;
}

export interface AuditRow {
  id: number;
  ts: number;
  type: AuditType;
  sessionId: string | null;
  coordinationId: string | null;
  source: string;
  payloadJson: string | null;
}

export interface ApprovalRow {
  id: string;
  sessionId: string;
  toolName: string;
  requestJson: string;
  status: ApprovalStatus;
  decidedVia: DecidedVia | null;
  /** `session` when the operator approved this tool for the rest of the session. */
  scope: ApprovalScope;
  requestedAt: number;
  decidedAt: number | null;
}

export interface MemoryProposalRow {
  id: string;
  sessionId: string;
  category: ProposalCategory;
  proposedText: string;
  targetFile: string | null;
  status: ProposalStatus;
  createdAt: number;
  decidedAt: number | null;
}
