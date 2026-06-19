import { existsSync, readFileSync } from "node:fs";

import type { Clock } from "../core/clock.js";
import { systemClock } from "../core/clock.js";
import { uuid } from "../core/ids.js";
import { SwitchboardError } from "../core/errors.js";
import type { Store } from "../state/db.js";
import type { MemoryProposalRow, ProposalCategory } from "../state/types.js";
import { MemoryStore } from "./memory.js";

export interface ProposeInput {
  sessionId: string;
  category: ProposalCategory;
  proposedText: string;
  targetFile?: string | null;
}

export type PromoteVia = "dispatcher" | "dashboard" | "operator";

/**
 * The curated-memory discipline (§5.6, Invariant 5). Child sessions only ever
 * PROPOSE — they write to their own session-local scratch, which is ingested
 * into the `memory_proposals` queue. Only the dispatcher or operator PROMOTES,
 * and every promotion is an audit-logged `memory_promotion` carrying the source
 * session id, so "why does the system now believe this" is always answerable.
 * This blocks time-shifted / memory-poisoning injection.
 */
export class MemoryService {
  constructor(
    private readonly store: Store,
    private readonly memory: MemoryStore,
    private readonly clock: Clock = systemClock,
  ) {}

  /** Proposal ids being promoted right now — in-process guard against a concurrent
   * same-id promote double-appending (all promotion runs in the single daemon process). */
  private readonly promoting = new Set<string>();

  /** Record a proposal (the child path; never writes shared memory directly). */
  propose(input: ProposeInput): MemoryProposalRow {
    return this.store.proposals.create({
      id: uuid(),
      sessionId: input.sessionId,
      category: input.category,
      proposedText: input.proposedText,
      targetFile: input.targetFile ?? null,
    });
  }

  pending(): MemoryProposalRow[] {
    return this.store.proposals.listPending();
  }

  /**
   * Promote a proposal into shared memory. Resolves the (contained) target file,
   * appends a provenance-stamped block, marks the proposal promoted, and audits
   * `memory_promotion` with the source session id. Throws if already decided.
   */
  promote(proposalId: string, via: PromoteVia = "dispatcher"): { file: string } {
    const p = this.store.proposals.get(proposalId);
    if (!p) throw new SwitchboardError("unknown_proposal", `no proposal '${proposalId}'`);
    if (p.status !== "pending") {
      throw new SwitchboardError("already_decided", `proposal '${proposalId}' is ${p.status}`);
    }
    if (this.promoting.has(proposalId)) {
      throw new SwitchboardError("already_decided", `proposal '${proposalId}' promotion already in flight`);
    }
    this.promoting.add(proposalId);
    try {
      const file = this.memory.resolveFile(p.category, p.targetFile);
      // Append FIRST; claim the pending→promoted transition only after the write
      // succeeds, so a failed append leaves the proposal pending (retryable) rather than
      // promoted-but-unwritten. The in-process guard above prevents a concurrent same-id
      // promote from double-appending in the window before the transition lands.
      this.memory.appendEntry(file, p.proposedText, {
        sessionId: p.sessionId,
        iso: new Date(this.clock.now()).toISOString(),
      });
      if (!this.store.proposals.resolve(proposalId, "promoted")) {
        throw new SwitchboardError("already_decided", `proposal '${proposalId}' was decided concurrently`);
      }
      this.store.audit.append({
        type: "memory_promotion",
        sessionId: p.sessionId,
        source: via === "dashboard" ? "dashboard" : "dispatcher",
        payload: { proposalId, file, category: p.category, via },
      });
      return { file };
    } finally {
      this.promoting.delete(proposalId);
    }
  }

  reject(proposalId: string): void {
    if (this.store.proposals.resolve(proposalId, "rejected")) {
      this.store.audit.append({
        type: "status_change",
        source: "dispatcher",
        payload: { event: "proposal_rejected", proposalId },
      });
    }
  }

  /** Learned context injected at task start (§7.1) — always treated as DATA. */
  readContext(repo?: string): string {
    return this.memory.readContext(repo);
  }

  /**
   * Ingest a session's locally-proposed entries (`<workingDir>/.switchboard-proposals.jsonl`,
   * one JSON object per line) into the proposal queue. Children write only to
   * their own scratch; this is the controlled bridge into shared state. Malformed
   * lines and bad categories are skipped, not trusted.
   */
  ingestSessionProposals(sessionId: string, workingDir: string): number {
    const file = `${workingDir.replace(/\/+$/, "")}/.switchboard-proposals.jsonl`;
    if (!existsSync(file)) return 0;
    const validCategories: ProposalCategory[] = ["convention", "task_pattern", "feedback", "policy_candidate"];
    let count = 0;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      let obj: { category?: string; text?: string; targetFile?: string };
      try {
        obj = JSON.parse(t);
      } catch {
        continue;
      }
      if (!obj.text || !validCategories.includes(obj.category as ProposalCategory)) continue;
      this.propose({
        sessionId,
        category: obj.category as ProposalCategory,
        proposedText: String(obj.text),
        targetFile: typeof obj.targetFile === "string" ? obj.targetFile : null,
      });
      count++;
    }
    return count;
  }
}
