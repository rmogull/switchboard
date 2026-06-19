import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Tmux, defaultTmuxConfig } from "../src/execution/tmux.js";
import { run } from "../src/execution/exec.js";

// Dedicated test socket + config file so we never touch the real `switchboard`
// server or the user's personal tmux. Exercises the real tmux binary — cheap,
// no AI usage.
const dir = mkdtempSync(join(tmpdir(), "sw-tmux-"));
const configFile = join(dir, "tmux.conf");
writeFileSync(configFile, defaultTmuxConfig(50_000));
const tmux = new Tmux({ socket: "switchboard-vitest", configFile });

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterAll(async () => {
  await tmux.killServer();
});

describe("tmux manager (integration)", () => {
  it("creates a session, relays keystrokes, captures output, and kills it", async () => {
    expect(await tmux.isAvailable()).toBe(true);

    const name = "sw-vitest01";
    if (await tmux.hasSession(name)) await tmux.killSession(name);

    // `cat` keeps the pane alive and echoes whatever we send — lets us verify
    // the Signal-relay path (sendKeys) and the log-view path (capturePane).
    await tmux.newSession({ name, cwd: "/tmp", command: "cat" });
    expect(await tmux.hasSession(name)).toBe(true);
    expect(await tmux.listSessions()).toContain(name);

    await tmux.sendKeys(name, "hello-switchboard");
    await delay(300);
    const out = await tmux.capturePane(name);
    expect(out).toContain("hello-switchboard");

    await tmux.killSession(name);
    expect(await tmux.hasSession(name)).toBe(false);
  });

  it("loads the config at server start (history-limit applied before panes)", async () => {
    const name = "sw-vitest02";
    if (await tmux.hasSession(name)) await tmux.killSession(name);
    await tmux.newSession({ name, cwd: "/tmp", command: "cat" });
    const r = await run("tmux", [
      "-L",
      "switchboard-vitest",
      "show-options",
      "-g",
      "history-limit",
    ]);
    expect(r.stdout.trim()).toBe("history-limit 50000");
    await tmux.killSession(name);
  });

  it("reports the local attach command", () => {
    expect(tmux.attachCommand("sw-abc")).toBe(
      "tmux -L switchboard-vitest attach -t sw-abc",
    );
  });
});
