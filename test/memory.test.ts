import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { memoryStore } from "../src/state/db.js";
import { fixedClock } from "../src/core/clock.js";
import { MemoryStore } from "../src/memory/memory.js";
import { MemoryService } from "../src/memory/service.js";

function setup() {
  const home = mkdtempSync(join(tmpdir(), "sw-mem-"));
  const clock = fixedClock(1_700_000_000_000);
  const store = memoryStore(clock);
  store.sessions.create({ id: "s1", client: "claude", mode: "deliverable", workingDir: "/w" });
  const ms = new MemoryStore(home);
  const svc = new MemoryService(store, ms, clock);
  return { home, store, ms, svc };
}

describe("memory — propose → promote (Invariant 5)", () => {
  it("promotes into the category file with provenance and an audited source session", () => {
    const { home, store, svc } = setup();
    const p = svc.propose({ sessionId: "s1", category: "feedback", proposedText: "prefers two-space indentation" });
    expect(svc.pending()).toHaveLength(1);

    const { file } = svc.promote(p.id, "operator");
    expect(file).toBe(join(home, "memory", "learnings.md"));
    const body = readFileSync(file, "utf8");
    expect(body).toContain("prefers two-space indentation");
    expect(body).toContain("promoted from session s1");
    expect(svc.pending()).toHaveLength(0);

    const promo = store.audit.recent().find((a) => a.type === "memory_promotion");
    expect(promo?.sessionId).toBe("s1");
  });

  it("rejects a proposal", () => {
    const { svc, store } = setup();
    const p = svc.propose({ sessionId: "s1", category: "task_pattern", proposedText: "x" });
    svc.reject(p.id);
    expect(svc.pending()).toHaveLength(0);
    expect(store.proposals.get(p.id)!.status).toBe("rejected");
  });

  it("won't promote an already-decided proposal twice", () => {
    const { svc } = setup();
    const p = svc.propose({ sessionId: "s1", category: "feedback", proposedText: "once" });
    svc.promote(p.id);
    expect(() => svc.promote(p.id)).toThrow(/already_decided|promoted/);
  });

  it("contains child-supplied target paths strictly under the memory dir", () => {
    const { svc } = setup();
    const traversal = svc.propose({ sessionId: "s1", category: "convention", proposedText: "x", targetFile: "../../etc/evil.md" });
    expect(() => svc.promote(traversal.id)).toThrow(/escapes|memory_path/);
    const notMd = svc.propose({ sessionId: "s1", category: "convention", proposedText: "x", targetFile: "conventions/note.txt" });
    expect(() => svc.promote(notMd.id)).toThrow(/\.md/);
  });

  it("reads learned context (as data) from promoted entries", () => {
    const { svc } = setup();
    svc.promote(svc.propose({ sessionId: "s1", category: "feedback", proposedText: "likes concise decks" }).id);
    svc.promote(svc.propose({ sessionId: "s1", category: "task_pattern", proposedText: "CSA deck uses template X" }).id);
    const ctx = svc.readContext();
    expect(ctx).toContain("likes concise decks");
    expect(ctx).toContain("CSA deck uses template X");
  });

  it("ingests only valid session-local proposal lines (children write scratch)", () => {
    const { svc } = setup();
    const wd = mkdtempSync(join(tmpdir(), "sw-wd-"));
    writeFileSync(
      join(wd, ".switchboard-proposals.jsonl"),
      [
        JSON.stringify({ category: "feedback", text: "good entry" }),
        "not json at all",
        JSON.stringify({ category: "bogus", text: "bad category" }),
        JSON.stringify({ text: "missing category" }),
      ].join("\n") + "\n",
    );
    const n = svc.ingestSessionProposals("s1", wd);
    expect(n).toBe(1);
    expect(svc.pending()[0]!.proposedText).toBe("good entry");
  });
});
