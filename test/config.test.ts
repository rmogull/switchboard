import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configSchema } from "../src/config/schema.js";
import { loadConfig } from "../src/config/index.js";

describe("config schema defaults", () => {
  it("fills nested defaults from empty input (prefault)", () => {
    const c = configSchema.parse({});
    expect(c.home).toBe("~/.switchboard");
    expect(c.dashboard.port).toBe(8765);
    expect(c.dashboard.bindAddress).toBe("127.0.0.1");
    expect(c.signal.enabled).toBe(false);
    expect(c.signal.allowlist).toEqual([]);
    expect(c.approvals.onTimeout).toBe("deny");
    expect(c.approvals.timeoutMs).toBe(120_000);
    expect(c.clients.claude.enabled).toBe(true);
    expect(c.clients.codex.enabled).toBe(true);
    expect(c.tmux.historyLimit).toBe(50_000);
    expect(c.tmux.sessionPrefix).toBe("sw");
  });

  it("rejects an unknown permission decision value", () => {
    const r = configSchema.safeParse({
      policy: { overrides: { delete: "maybe" } },
    });
    expect(r.success).toBe(false);
  });

  it("keeps user-provided values over defaults", () => {
    const c = configSchema.parse({
      signal: { enabled: true, account: "+15550000000", allowlist: ["+15551111111"] },
      dashboard: { port: 9000 },
    });
    expect(c.signal.enabled).toBe(true);
    expect(c.signal.account).toBe("+15550000000");
    expect(c.dashboard.port).toBe(9000);
    // Untouched siblings still get their defaults.
    expect(c.dashboard.bindAddress).toBe("127.0.0.1");
  });
});

describe("loadConfig", () => {
  it("expands ~ in home and derives the default db path", () => {
    const dir = mkdtempSync(join(tmpdir(), "sw-cfg-"));
    const cfgPath = join(dir, "switchboard.config.json");
    writeFileSync(cfgPath, JSON.stringify({ home: join(dir, "home") }));
    const cfg = loadConfig({ path: cfgPath });
    expect(cfg.home).toBe(join(dir, "home"));
    expect(cfg.dbPath).toBe(join(dir, "home", "switchboard", "switchboard.db"));
    expect(cfg.configPath).toBe(cfgPath);
  });

  it("throws a ConfigError with code on invalid JSON shape", () => {
    const dir = mkdtempSync(join(tmpdir(), "sw-cfg-"));
    const cfgPath = join(dir, "bad.json");
    writeFileSync(cfgPath, JSON.stringify({ dashboard: { port: "not-a-number" } }));
    expect(() => loadConfig({ path: cfgPath })).toThrowError(/config_invalid|invalid configuration/);
  });
});
