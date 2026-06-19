import { describe, it, expect } from "vitest";
import { realpathSync } from "node:fs";

import { renderPlist } from "../src/launchd/plist.js";
import { buildPlistOptions, installDaemon } from "../src/launchd/install.js";
import type { ResolvedConfig } from "../src/config/index.js";

describe("launchd plist", () => {
  it("renders the required keys for a kept-alive agent", () => {
    const xml = renderPlist({
      label: "com.switchboard.daemon",
      programArguments: ["/usr/bin/node", "/x/dist/cli/index.js", "daemon"],
      workingDirectory: "/home/me",
      env: { PATH: "/opt/homebrew/bin:/usr/bin", SWITCHBOARD_HOME: "/home/me" },
      stdoutPath: "/home/me/logs/daemon.out.log",
      stderrPath: "/home/me/logs/daemon.err.log",
    });
    expect(xml.startsWith("<?xml")).toBe(true);
    expect(xml).toContain("<string>com.switchboard.daemon</string>");
    expect(xml).toContain("<string>/x/dist/cli/index.js</string>");
    expect(xml).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(xml).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(xml).toContain("<key>PATH</key>");
    expect(xml).toContain("<string>/home/me/logs/daemon.err.log</string>");
  });

  it("escapes XML special characters", () => {
    const xml = renderPlist({
      label: "a&b<c",
      programArguments: ["x"],
      workingDirectory: "/",
      env: {},
      stdoutPath: "/o",
      stderrPath: "/e",
    });
    expect(xml).toContain("a&amp;b&lt;c");
  });
});

describe("launchd install — node pin + test-profile guard", () => {
  it("pins the daemon to a stable realpath'd node, not a floating symlink", () => {
    const cfg = { home: "/tmp/h", stateDir: "/tmp/s", configPath: "<defaults>" } as unknown as ResolvedConfig;
    const opts = buildPlistOptions(cfg, { dev: true });
    expect(opts.programArguments[0]).toBe(realpathSync(process.execPath));
  });

  it("refuses to install the daemon from a non-default tmux profile (test/sandbox config)", async () => {
    // The guard is the first statement in installDaemon, so this rejects WITHOUT
    // touching launchctl or replacing the production daemon.
    const cfg = {
      tmux: { socket: "switchboard-test" },
      home: "/tmp/h",
      stateDir: "/tmp/s",
      configPath: "/tmp/t.json",
    } as unknown as ResolvedConfig;
    await expect(installDaemon(cfg)).rejects.toThrow(/refuse|non-default|test/i);
  });
});
