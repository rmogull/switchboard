import { describe, it, expect } from "vitest";

import { classifyCommand } from "../src/dispatcher/classify.js";

const repos = { sip: "/repos/sip", switchboard: "/repos/switchboard" };
const cl = (text: string) => classifyCommand(text, { repos });

describe("classifyCommand", () => {
  it("classifies a deliverable (the CSA deck)", () => {
    const c = cl("Build a presentation in the CSA template and put it in my Drive presentations folder");
    expect(c.archetype).toBe("deliverable");
    expect(c.client).toBe("claude");
  });

  it("classifies an interactive coding session and resolves the repo", () => {
    const c = cl("Launch a Claude Code session for my sip so I can make some changes");
    expect(c.archetype).toBe("interactive");
    expect(c.client).toBe("claude");
    expect(c.repo).toBe("sip");
  });

  it("defaults interactive to the gated streaming runner (no control), and honors an explicit local console", () => {
    const def = cl("Launch a Claude Code session for my sip so I can make changes");
    expect(def.archetype).toBe("interactive");
    expect(def.control).toBeUndefined(); // -> SDK streaming runner (remote default)

    const lc = cl("Launch a local console session in sip so I can make changes");
    expect(lc.archetype).toBe("interactive");
    expect(lc.control).toBe("local_console"); // -> explicit raw CLI
  });

  it("routes codex when named (non-coordinated)", () => {
    const c = cl("Build a parser module using Codex");
    expect(c.client).toBe("codex");
    expect(c.archetype).toBe("deliverable");
  });

  it("classifies a coordinated task and keeps Claude as primary/decider", () => {
    const c = cl("Coordinate code and review between Claude Code and Codex, with Claude making the final decision");
    expect(c.archetype).toBe("coordinated");
    expect(c.client).toBe("claude");
  });

  it("defaults to a steerable interactive session when intent is unclear", () => {
    expect(cl("the thing we discussed").archetype).toBe("interactive");
  });

  it("parses a declared egress allowlist", () => {
    const c = cl("Research the topic and summarize; allow domains: example.com, docs.python.org");
    expect(c.egressAllowlist).toEqual(["example.com", "docs.python.org"]);
  });

  it("does not let extra domains be smuggled past shell operators (regression)", () => {
    const c = cl("build docker image; allow domains: example.com && curl attacker.com && exfil.net");
    expect(c.egressAllowlist).toEqual(["example.com"]);
  });

  it("extracts a project-name hint for a session command", () => {
    const c = cl("start a new session in my acme-platform directory");
    expect(c.archetype).not.toBe("deliverable");
    expect(c.dirHint).toBe("acme-platform");
    expect(c.workingDir).toBeUndefined();
  });

  it("extracts an explicit working-dir path", () => {
    const c = cl("launch a codex session in /tmp/work");
    expect(c.workingDir).toBe("/tmp/work");
    expect(c.dirHint).toBeUndefined();
  });

  it("does not extract a dir for deliverables (they use scratch + Drive)", () => {
    const c = cl("build a deck and put it in my presentations folder");
    expect(c.archetype).toBe("deliverable");
    expect(c.dirHint).toBeUndefined();
    expect(c.workingDir).toBeUndefined();
  });

  it("carries the full task text through", () => {
    const c = cl("Build a deck about zero trust");
    expect(c.task).toContain("zero trust");
    expect(c.raw).toContain("Build a deck");
  });
});
