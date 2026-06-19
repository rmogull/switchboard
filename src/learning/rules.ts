import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { uuid } from "../core/ids.js";

/**
 * A learned auto-allow rule (§5.6 / Phase 6). Created ONLY by explicit operator
 * confirmation of a suggestion — never inferred silently. Persisted as JSON under
 * the home dir and loaded by the permission policy, which uses a rule to upgrade
 * a would-be `ask` to `allow` for the specific learned target.
 *
 *  - kind "write"  → scope is a path prefix; auto-allows writes beneath it
 *  - kind "egress" → scope is a domain;     auto-allows egress to it/subdomains
 */
export type LearnedRuleKind = "write" | "egress";

export interface LearnedRule {
  id: string;
  kind: LearnedRuleKind;
  scope: string;
  reason: string;
  sourceApprovalIds: string[];
  createdAt: number;
}

export class LearnedRulesStore {
  private readonly file: string;

  constructor(stateDir: string) {
    this.file = join(stateDir, "learned-rules.json");
  }

  load(): LearnedRule[] {
    if (!existsSync(this.file)) return [];
    try {
      const data = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
      return Array.isArray(data) ? (data as LearnedRule[]) : [];
    } catch {
      return [];
    }
  }

  has(kind: LearnedRuleKind, scope: string): boolean {
    return this.load().some((r) => r.kind === kind && r.scope === scope);
  }

  add(input: { kind: LearnedRuleKind; scope: string; reason: string; sourceApprovalIds: string[]; createdAt: number }): LearnedRule {
    const rules = this.load();
    const rule: LearnedRule = { id: uuid().slice(0, 8), ...input };
    rules.push(rule);
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(rules, null, 2));
    return rule;
  }
}
