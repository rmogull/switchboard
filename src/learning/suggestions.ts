import { createHash } from "node:crypto";
import { dirname } from "node:path";

import type { Store } from "../state/db.js";
import type { LearnedRule, LearnedRuleKind } from "./rules.js";

export interface Candidate {
  /** Stable id derived from kind+scope, so `promote <id>` re-resolves it. */
  id: string;
  kind: LearnedRuleKind;
  scope: string;
  count: number;
  approvalIds: string[];
  description: string;
}

function stableId(kind: string, scope: string): string {
  return createHash("sha256").update(`${kind}|${scope}`).digest("hex").slice(0, 8);
}

/**
 * Mine the approval history for recurring approvals that are good auto-allow
 * candidates (Phase 6). Because only `ask` decisions ever create approvals, an
 * *approved* write is necessarily an outside-workdir write, and an approved
 * egress is necessarily a non-allowlisted host. We group writes by target
 * directory and egress by host; a group at/above the threshold (and not already
 * covered by a learned rule) becomes a candidate the dispatcher suggests.
 */
export function detectCandidates(store: Store, existing: LearnedRule[], threshold = 5): Candidate[] {
  const approved = store.db
    .prepare("SELECT id, request_json FROM approvals WHERE status = 'approved'")
    .all() as { id: string; request_json: string }[];

  const groups = new Map<string, { kind: LearnedRuleKind; scope: string; ids: string[] }>();
  const push = (kind: LearnedRuleKind, scope: string, id: string) => {
    const key = `${kind}|${scope}`;
    const g = groups.get(key) ?? { kind, scope, ids: [] };
    g.ids.push(id);
    groups.set(key, g);
  };

  for (const a of approved) {
    let d: { action?: string; path?: string; hosts?: string[] };
    try {
      d = JSON.parse(a.request_json);
    } catch {
      continue;
    }
    if (d.action === "write_outside_workdir" && typeof d.path === "string") {
      push("write", dirname(d.path), a.id);
    } else if (d.action === "network_egress" && Array.isArray(d.hosts)) {
      for (const h of d.hosts) if (typeof h === "string" && h) push("egress", h.toLowerCase(), a.id);
    }
  }

  const candidates: Candidate[] = [];
  for (const g of groups.values()) {
    if (g.ids.length < threshold) continue;
    if (existing.some((r) => r.kind === g.kind && r.scope === g.scope)) continue;
    candidates.push({
      id: stableId(g.kind, g.scope),
      kind: g.kind,
      scope: g.scope,
      count: g.ids.length,
      approvalIds: g.ids,
      description:
        g.kind === "write"
          ? `auto-allow writes under ${g.scope} (approved ${g.ids.length}×)`
          : `auto-allow egress to ${g.scope} (approved ${g.ids.length}×)`,
    });
  }
  // Most-approved first.
  candidates.sort((a, b) => b.count - a.count);
  return candidates;
}
