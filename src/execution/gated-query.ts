import { query } from "@anthropic-ai/claude-agent-sdk";

import type { ResolvedConfig } from "../config/index.js";
import type { Logger } from "../core/logger.js";
import type { Store } from "../state/db.js";
import { PermissionPolicy } from "../permissions/policy.js";
import { ApprovalGateway } from "../permissions/approvals.js";
import { createCanUseTool } from "../permissions/hook.js";
import { buildGatedSdkOptions } from "../permissions/session-options.js";
import { LearnedRulesStore } from "../learning/rules.js";

export interface GatedQueryArgs {
  prompt: string;
  workingDir: string;
  sessionId: string;
  store: Store;
  cfg: ResolvedConfig;
  egressAllowlist?: string[];
  disallowedTools?: string[];
  log?: Logger;
}

/**
 * Run one gated Claude SDK turn to completion and collect its output. Same
 * permission spine as the deliverable runner (policy + approval gateway +
 * canUseTool under settingSources:[] isolation), but synchronous and
 * non-streaming — used by the coordination engine for implement/review/decide
 * steps that produce an artifact the FSM routes.
 */
export async function runGatedQuery(args: GatedQueryArgs): Promise<{ text: string; result: string }> {
  const policy = new PermissionPolicy(
    args.cfg.policy.overrides,
    args.cfg.policy.egressAllowlist,
    new LearnedRulesStore(args.cfg.stateDir).load(),
  );
  const gateway = new ApprovalGateway(args.store, {
    timeoutMs: args.cfg.approvals.timeoutMs,
    pollMs: 1000,
  });
  const canUseTool = createCanUseTool({
    sessionId: args.sessionId,
    policy,
    // Coordination implement/review/decide turns are unattended → interpreters ask.
    ctx: { workingDir: args.workingDir, egressAllowlist: args.egressAllowlist ?? [], unattended: true },
    gateway,
    store: args.store,
    ...(args.log ? { log: args.log } : {}),
  });

  const res = query({
    prompt: args.prompt,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    options: buildGatedSdkOptions({
      cwd: args.workingDir,
      canUseTool,
      disallowedTools: ["AskUserQuestion", ...(args.disallowedTools ?? [])],
    }) as any,
  });

  let text = "";
  let result = "";
  for await (const m of res) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mm = m as any;
    if (mm.type === "assistant") {
      for (const b of mm.message?.content ?? []) {
        if (b.type === "text" && b.text) text += b.text;
      }
    }
    if (mm.type === "result") result = String(mm.result ?? mm.subtype ?? "");
  }
  return { text, result };
}
