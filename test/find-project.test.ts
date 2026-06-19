import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findProjectDir } from "../src/dispatcher/find-project.js";

describe("findProjectDir", () => {
  it("finds an exact-name project directly under a root", () => {
    const root = mkdtempSync(join(tmpdir(), "sw-roots-"));
    mkdirSync(join(root, "security-intelligence-platform"));
    mkdirSync(join(root, "other-thing"));
    expect(findProjectDir("security-intelligence-platform", [root])).toBe(join(root, "security-intelligence-platform"));
  });

  it("searches two levels deep and prefers an exact over a partial match", () => {
    const root = mkdtempSync(join(tmpdir(), "sw-roots-"));
    mkdirSync(join(root, "org", "myproj-extra"), { recursive: true });
    mkdirSync(join(root, "org", "myproj"));
    expect(findProjectDir("myproj", [root])).toBe(join(root, "org", "myproj"));
  });

  it("is case-insensitive", () => {
    const root = mkdtempSync(join(tmpdir(), "sw-roots-"));
    mkdirSync(join(root, "SIP-Backend"));
    expect(findProjectDir("sip-backend", [root])).toBe(join(root, "SIP-Backend"));
  });

  it("returns undefined when nothing matches (→ scratch fallback)", () => {
    const root = mkdtempSync(join(tmpdir(), "sw-roots-"));
    mkdirSync(join(root, "alpha"));
    expect(findProjectDir("nonexistent-xyz", [root])).toBeUndefined();
  });
});
