import { describe, it, expect } from "vitest";

import { assessAdoptedSandbox } from "../src/execution/ironcurtain/daemon.js";

const SUPPORTED = new Set([22, 23, 24]);

describe("assessAdoptedSandbox (IronCurtain adopt-path safety)", () => {
  it("refuses a daemon proven to run an unsupported node major", () => {
    expect(assessAdoptedSandbox({ nodeVersion: "v26.3.0" }, SUPPORTED)).toEqual({
      ok: false,
      reason: expect.stringContaining("node 26"),
    });
    expect(assessAdoptedSandbox({ node: 26 }, SUPPORTED)).toMatchObject({ ok: false });
    expect(assessAdoptedSandbox({ runtime: { node: "v25.0.0" } }, SUPPORTED)).toMatchObject({ ok: false });
  });

  it("refuses a daemon reporting an inactive sandbox", () => {
    expect(assessAdoptedSandbox({ sandbox: false }, SUPPORTED)).toMatchObject({ ok: false });
    expect(assessAdoptedSandbox({ sandboxActive: "disabled" }, SUPPORTED)).toMatchObject({ ok: false });
    expect(assessAdoptedSandbox({ v8Sandbox: { active: false } }, SUPPORTED)).toMatchObject({ ok: false });
  });

  it("accepts a supported node and marks it verified", () => {
    expect(assessAdoptedSandbox({ nodeVersion: "v24.1.0" }, SUPPORTED)).toEqual({ ok: true, verified: true });
    expect(assessAdoptedSandbox({ node: 22, sandbox: true }, SUPPORTED)).toEqual({ ok: true, verified: true });
  });

  it("accepts but marks UNVERIFIED when the payload carries no node/sandbox signal", () => {
    expect(assessAdoptedSandbox({}, SUPPORTED)).toEqual({ ok: true, verified: false });
    expect(assessAdoptedSandbox(null, SUPPORTED)).toEqual({ ok: true, verified: false });
    expect(assessAdoptedSandbox("pong", SUPPORTED)).toEqual({ ok: true, verified: false });
  });
});
