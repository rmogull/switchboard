import { existsSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { ResolvedConfig } from "../config/index.js";
import { DependencyError, SwitchboardError } from "../core/errors.js";
import { packageRoot } from "../core/self-invoke.js";
import { checkNativeModule } from "../core/native-check.js";
import { run } from "../execution/exec.js";
import { renderPlist, type PlistOptions } from "./plist.js";

export const DEFAULT_LABEL = "com.switchboard.daemon";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function plistPath(label: string): string {
  return join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
}

function launchctlDomainTarget(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return `gui/${uid}`;
}

/**
 * Build the plist for the dispatcher daemon. In production it runs the bundled
 * CLI (`node dist/cli/index.js daemon`); with `dev: true` it runs from source
 * via tsx, which is handy before a build exists.
 */
export function buildPlistOptions(
  cfg: ResolvedConfig,
  opts: { label?: string; dev?: boolean } = {},
): PlistOptions {
  const label = opts.label ?? DEFAULT_LABEL;
  const root = packageRoot();

  // Pin the daemon to a STABLE, version-specific node path (resolve the floating
  // Homebrew `/opt/homebrew/bin/node` symlink to its Cellar target) so a later
  // `brew upgrade node` can't silently re-point the daemon at a new, ABI-incompatible
  // Node. If the pinned version is later removed, launchd fails loudly (file not
  // found) instead of crash-looping on a NODE_MODULE_VERSION mismatch.
  const nodeBin = realpathSync(process.execPath);

  let programArguments: string[];
  if (opts.dev) {
    programArguments = [nodeBin, join(root, "node_modules/.bin/tsx"), join(root, "src/cli/index.ts"), "daemon"];
  } else {
    const distCli = join(root, "dist/cli/index.js");
    if (!existsSync(distCli)) {
      throw new DependencyError(`built CLI not found at ${distCli} — run \`npm run build\` first (or use --dev)`);
    }
    programArguments = [nodeBin, distCli, "daemon"];
  }

  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME ?? homedir(),
    SWITCHBOARD_HOME: cfg.home,
  };
  if (cfg.configPath !== "<defaults>") env.SWITCHBOARD_CONFIG = cfg.configPath;

  return {
    label,
    programArguments,
    workingDirectory: cfg.home,
    env,
    stdoutPath: join(cfg.stateDir, "logs", "daemon.out.log"),
    stderrPath: join(cfg.stateDir, "logs", "daemon.err.log"),
    runAtLoad: true,
    keepAlive: true,
  };
}

/** Render the plist text without touching launchd or the filesystem. */
export function renderDaemonPlist(cfg: ResolvedConfig, opts: { label?: string; dev?: boolean } = {}): string {
  return renderPlist(buildPlistOptions(cfg, opts));
}

export interface InstallResult {
  label: string;
  plistPath: string;
  loaded: boolean;
}

/**
 * Write the plist to ~/Library/LaunchAgents and load it via launchctl. Idempotent:
 * boots out any prior instance first so re-install picks up changes.
 */
export async function installDaemon(
  cfg: ResolvedConfig,
  opts: { label?: string; dev?: boolean } = {},
): Promise<InstallResult> {
  const label = opts.label ?? DEFAULT_LABEL;
  // Refuse to install from a test/sandbox profile: a non-default tmux socket means this
  // is not the production config, and installing it would replace the real daemon under
  // the shared label (booting out the live one).
  if (cfg.tmux.socket !== "switchboard") {
    throw new SwitchboardError(
      "refuse_install_test_profile",
      `Refusing to install the launchd daemon from a non-default tmux profile (tmux.socket="${cfg.tmux.socket}"). ` +
        `This looks like a test/sandbox config; it would replace the production daemon under "${label}". ` +
        `Install from your real config (tmux.socket="switchboard").`,
    );
  }
  // Verify the native DB module loads under the installing Node BEFORE pinning the plist
  // to it — the daemon runs the same binary, so a load here guarantees an ABI match
  // (otherwise a friendly rebuild remedy is thrown instead of a launchd crash-loop).
  checkNativeModule();
  const plOpts = buildPlistOptions(cfg, opts);
  const dest = plistPath(label);

  mkdirSync(dirname(dest), { recursive: true });
  mkdirSync(join(cfg.stateDir, "logs"), { recursive: true });
  writeFileSync(dest, renderPlist(plOpts));

  const domain = launchctlDomainTarget();
  // Replace any prior instance. bootout is asynchronous — wait for the service to
  // actually unload before bootstrapping, or bootstrap fails with EIO (errno 5).
  await run("launchctl", ["bootout", `${domain}/${label}`]);
  for (let i = 0; i < 20; i++) {
    const printed = await run("launchctl", ["print", `${domain}/${label}`]);
    if (printed.code !== 0) break; // no longer loaded
    await delay(250);
  }
  let r = await run("launchctl", ["bootstrap", domain, dest]);
  if (r.code !== 0) {
    await delay(500);
    r = await run("launchctl", ["bootstrap", domain, dest]); // one retry after a beat
  }
  const loaded = r.code === 0;
  if (!loaded) {
    throw new SwitchboardError(
      "launchctl_bootstrap",
      `launchctl bootstrap failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`,
    );
  }
  return { label, plistPath: dest, loaded };
}

export async function uninstallDaemon(label = DEFAULT_LABEL): Promise<void> {
  const domain = launchctlDomainTarget();
  await run("launchctl", ["bootout", `${domain}/${label}`]);
  const dest = plistPath(label);
  if (existsSync(dest)) rmSync(dest);
}

export async function daemonStatus(label = DEFAULT_LABEL): Promise<string> {
  const domain = launchctlDomainTarget();
  const r = await run("launchctl", ["print", `${domain}/${label}`]);
  if (r.code !== 0) return `not loaded (${label})`;
  // Extract the most useful lines (state, pid) from launchctl print's verbose output.
  const lines = r.stdout.split("\n").filter((l) => /\b(state|pid)\s*=/.test(l));
  return lines.length ? lines.map((l) => l.trim()).join("\n") : `loaded (${label})`;
}
