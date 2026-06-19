import type { Logger } from "../core/logger.js";
import type { Store } from "../state/db.js";
import type { ApprovalGateway, ApprovalOutcome } from "./approvals.js";
import type { PermissionPolicy, PolicyContext } from "./policy.js";

/**
 * Result shape the Agent SDK's canUseTool expects (matches the validated Phase 0
 * Spike 1 probe): allow with the (possibly updated) input, or deny with a reason.
 */
export type ToolPermissionResult =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string };

export type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options?: { signal?: AbortSignal },
) => Promise<ToolPermissionResult>;

export interface HookDeps {
  sessionId: string;
  policy: PermissionPolicy;
  ctx: PolicyContext;
  gateway: ApprovalGateway;
  store: Store;
  log?: Logger;
}

/** Order-independent serialization so two identical tool inputs hash the same. */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(",")}}`;
}

/**
 * Build the canUseTool callback for a gated Claude session (§5.5) — the headless
 * deliverable/coordinated runner AND the interactive streaming runner. Every
 * tool-use is evaluated by the policy and audited; allow and deny return
 * immediately, while `ask` blocks on the out-of-band approval round-trip and the
 * session is marked awaiting_approval meanwhile. The SDK's AbortSignal (3rd arg)
 * is threaded into the approval wait, so an operator /interrupt releases a parked
 * approval immediately (denied) instead of waiting out the timeout.
 *
 * Two per-session memories live in this closure (one closure per session runner):
 *  - `sessionGrants`: tools the operator explicitly approved for the whole session
 *    (an `approve-for-session` reply). A later use of a granted tool is auto-allowed
 *    and still audited — so a re-used MCP integration isn't re-prompted every call.
 *    Keyed on tool name only (the operator's opt-in is "trust this tool here").
 *  - `inFlight`: collapses CONCURRENT identical asks (same tool + same input) onto
 *    ONE approval round-trip, so the SDK firing two identical tool calls in a turn
 *    can't produce two separate prompts. Sequential (non-overlapping) repeats still
 *    re-ask unless the tool was granted for the session — that's the `once` contract.
 *
 * Only the explicit `local_console` / raw-CLI surface bypasses this hook (it
 * answers prompts natively in the TTY); the remote default is gated here.
 */
export function createCanUseTool(deps: HookDeps): CanUseTool {
  const sessionGrants = new Set<string>();
  const inFlight = new Map<string, Promise<ApprovalOutcome>>();

  return async (toolName, input, options) => {
    const ev = deps.policy.evaluate(toolName, input, deps.ctx);
    deps.store.audit.append({
      type: "tool_use",
      sessionId: deps.sessionId,
      source: "policy",
      payload: { toolName, action: ev.action, decision: ev.decision, detail: ev.detail },
    });

    if (ev.decision === "allow") return { behavior: "allow", updatedInput: input };
    if (ev.decision === "deny") {
      return { behavior: "deny", message: `denied by policy (${ev.action})` };
    }

    // ask → but if the operator already approved this tool for the whole session,
    // auto-allow it (still audited) rather than re-prompting.
    if (sessionGrants.has(toolName)) {
      deps.store.audit.append({
        type: "approval_decision",
        sessionId: deps.sessionId,
        source: "policy",
        payload: { toolName, status: "approved", via: "session_grant" },
      });
      return { behavior: "allow", updatedInput: input };
    }

    // ask → block on an out-of-band decision; fail closed on timeout, and release
    // promptly if the SDK turn is interrupted (options.signal aborts). Concurrent
    // identical asks share a single approval round-trip (no duplicate prompts).
    const key = `${toolName}\u0000${stableStringify(input)}`;
    let pending = inFlight.get(key);
    if (!pending) {
      pending = (async () => {
        deps.store.sessions.setStatus(deps.sessionId, "awaiting_approval");
        try {
          return await deps.gateway.requestDecision({
            sessionId: deps.sessionId,
            toolName,
            // Include the policy action so the learning loop can mine approval history.
            request: { action: ev.action, ...ev.detail },
            ...(options?.signal ? { signal: options.signal } : {}),
          });
        } finally {
          deps.store.sessions.setStatus(deps.sessionId, "running");
        }
      })();
      inFlight.set(key, pending);
      void pending.finally(() => inFlight.delete(key));
    }
    const outcome = await pending;

    if (outcome.approved) {
      if (outcome.scope === "session") sessionGrants.add(toolName);
      return { behavior: "allow", updatedInput: input };
    }
    return {
      behavior: "deny",
      message: `denied (${outcome.status}) for ${ev.action}`,
    };
  };
}
