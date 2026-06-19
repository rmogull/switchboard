import { describe, it, expect } from "vitest";

import { memoryStore } from "../src/state/db.js";

function store() {
  const s = memoryStore();
  s.sessions.create({ id: "s1", client: "claude", mode: "interactive", workingDir: "/w" });
  return s;
}

describe("TranscriptRepo", () => {
  it("appends and reads after a cursor (incremental polling)", () => {
    const s = store();
    const a = s.transcript.append({ sessionId: "s1", kind: "user", source: "signal", text: "hi" });
    const b = s.transcript.append({ sessionId: "s1", kind: "assistant", source: "model", text: "hello" });
    expect(s.transcript.listAfter("s1", 0).map((r) => r.text)).toEqual(["hi", "hello"]);
    expect(s.transcript.listAfter("s1", a.seq).map((r) => r.text)).toEqual(["hello"]);
    expect(s.transcript.listAfter("s1", b.seq)).toHaveLength(0);
  });

  it("listRecent returns the tail in chronological order", () => {
    const s = store();
    for (let i = 0; i < 5; i++) {
      s.transcript.append({ sessionId: "s1", kind: "user", source: "signal", text: `m${i}` });
    }
    expect(s.transcript.listRecent("s1", 3).map((r) => r.text)).toEqual(["m2", "m3", "m4"]);
  });

  it("is append-only — UPDATE and DELETE are rejected by triggers", () => {
    const s = store();
    const r = s.transcript.append({ sessionId: "s1", kind: "user", source: "signal", text: "x" });
    expect(() => s.db.prepare("UPDATE transcript SET text='y' WHERE seq=?").run(r.seq)).toThrow(/append-only/);
    expect(() => s.db.prepare("DELETE FROM transcript WHERE seq=?").run(r.seq)).toThrow(/append-only/);
  });

  it("blocks the INSERT OR REPLACE rewrite bypass (recursive_triggers ON)", () => {
    const s = store();
    const r = s.transcript.append({ sessionId: "s1", kind: "user", source: "signal", text: "orig" });
    expect(() =>
      s.db
        .prepare(
          "INSERT OR REPLACE INTO transcript (seq, session_id, ts, kind, source, text) VALUES (?,?,?,?,?,?)",
        )
        .run(r.seq, "s1", 0, "user", "signal", "rewritten"),
    ).toThrow(/append-only/);
    expect(s.transcript.get(r.seq)!.text).toBe("orig"); // unchanged
  });

  it("clamps an oversized row to the max text length", () => {
    const s = store();
    const r = s.transcript.append({ sessionId: "s1", kind: "assistant", source: "model", text: "z".repeat(70_000) });
    expect(r.text.length).toBeLessThan(65_000);
    expect(r.text).toContain("truncated");
  });
});
