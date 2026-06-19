import { describe, it, expect } from "vitest";

import { toSignalDigest, sessionIdFromQuotedText } from "../src/control/signal-digest.js";

describe("toSignalDigest — verbosity-split chokepoint", () => {
  it("suppresses empty text", () => {
    expect(toSignalDigest({ kind: "status", text: "   " }, "s1")).toBeNull();
    expect(toSignalDigest({ kind: "result", text: "" }, "s1")).toBeNull();
  });

  it("formats status and result with the session id", () => {
    expect(toSignalDigest({ kind: "status", text: "running" }, "s1")).toContain("s1");
    expect(toSignalDigest({ kind: "status", text: "running" }, "s1")).toContain("running");
    expect(toSignalDigest({ kind: "result", text: "done" }, "s1")).toContain("done");
  });

  it("clips a long result and points to the pane/dashboard for the rest", () => {
    const d = toSignalDigest({ kind: "result", text: "x".repeat(5000) }, "s1")!;
    expect(d.length).toBeLessThan(1600);
    expect(d).toContain("full output");
  });
});

describe("sessionIdFromQuotedText — recover the session id a reply targets", () => {
  it("round-trips its own digest formats", () => {
    expect(sessionIdFromQuotedText(toSignalDigest({ kind: "result", text: "done" }, "last-vd3")!)).toBe("last-vd3");
    expect(sessionIdFromQuotedText(toSignalDigest({ kind: "status", text: "running" }, "o365-aub")!)).toBe("o365-aub");
    expect(sessionIdFromQuotedText(toSignalDigest({ kind: "notice", text: "fyi" }, "csaorg-h40")!)).toBe("csaorg-h40");
  });
  it("recovers the id from approval prompts, spawn notices, and steering acks", () => {
    expect(sessionIdFromQuotedText("🔐 Session last-vd3 wants Bash")).toBe("last-vd3");
    expect(sessionIdFromQuotedText("⚠️ HIGH-RISK — Session fa7906f5 wants mcp__claude_ai_Gmail__search_threads")).toBe("fa7906f5");
    expect(sessionIdFromQuotedText("spawned o365-aub (claude/interactive)\ndir: /x")).toBe("o365-aub");
    expect(sessionIdFromQuotedText("→ last-vd3: queued (12 chars)")).toBe("last-vd3");
  });
  it("returns null when there is no recognizable id", () => {
    expect(sessionIdFromQuotedText("just some text the user typed")).toBeNull();
    expect(sessionIdFromQuotedText("")).toBeNull();
  });
});
