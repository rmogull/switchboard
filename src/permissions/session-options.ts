import type { CanUseTool } from "./hook.js";

/**
 * Build the Agent SDK options for a permission-GATED Claude session. This is the
 * ONLY sanctioned way to construct options for a headless Switchboard session.
 *
 * `settingSources: []` is NON-NEGOTIABLE and the whole reason this helper exists.
 * Without it the SDK loads the user's `~/.claude/settings.json`, whose
 * `permissions.allow` list pre-approves Bash / Write / Edit / etc. — and a
 * pre-approved tool NEVER reaches `canUseTool`, silently bypassing the entire
 * permission policy. Verified empirically: with ambient settings loaded, a Bash
 * `rm` ran without the hook firing; with `settingSources: []`, the same `rm`
 * routed through the policy → approval gateway. Isolation mode makes the policy
 * the sole authority (Invariant 7: structural, enforced by the executor).
 *
 * Trade-off: project CLAUDE.md and ambient settings are not auto-loaded, so the
 * dispatcher must inject any required context explicitly (§5.1) — which is the
 * desired behavior for controlled, isolated sessions anyway.
 */
export interface GatedSessionOptions {
  cwd: string;
  canUseTool: CanUseTool;
  /** Tools auto-allowed without even reaching canUseTool (e.g. read-only helpers). */
  allowedTools?: string[];
  disallowedTools?: string[];
}

export interface GatedSdkOptions {
  permissionMode: "default";
  settingSources: [];
  cwd: string;
  canUseTool: CanUseTool;
  allowedTools?: string[];
  disallowedTools?: string[];
}

export function buildGatedSdkOptions(o: GatedSessionOptions): GatedSdkOptions {
  const opts: GatedSdkOptions = {
    permissionMode: "default",
    settingSources: [], // see module doc — do not remove, do not make non-empty
    cwd: o.cwd,
    canUseTool: o.canUseTool,
  };
  if (o.allowedTools) opts.allowedTools = o.allowedTools;
  if (o.disallowedTools) opts.disallowedTools = o.disallowedTools;
  return opts;
}
