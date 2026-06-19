import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { ResolvedConfig } from "./config/index.js";
import { createLogger, type Logger } from "./core/logger.js";
import { resolveBinary } from "./core/deps.js";
import { expandHome } from "./core/paths.js";
import { Store } from "./state/db.js";
import { Tmux, defaultTmuxConfig } from "./execution/tmux.js";
import { SessionManager } from "./execution/session.js";
import { IronCurtainDaemon } from "./execution/ironcurtain/daemon.js";

const DEFAULT_TMUX_SOCKET = "switchboard";

/**
 * Decide which TMUX_TMPDIR to use so every Switchboard process (launchd daemon,
 * a CLI run from a login shell, an SSH attach) talks to the SAME tmux server.
 *
 * `tmux -L <socket>` resolves its socket under $TMUX_TMPDIR ?? $TMPDIR ?? /tmp,
 * and those differ across launch contexts (launchd has no TMPDIR → /tmp; a login
 * shell has TMPDIR=/var/folders/...). If we just trusted the ambient value, a CLI
 * run from a shell would look in the WRONG dir, see no sessions, and its reconcile
 * would wrongly mark every live session "done". So we PROBE the candidate dirs for
 * an existing socket and lock onto wherever the server actually is (mirrors the
 * phone-attach ForceCommand). If none is running yet, we fall back to a pinned dir
 * under the state dir so NEW servers land somewhere predictable.
 *
 * `probeAmbient` is true ONLY for the default socket. A custom socket (a separate
 * test/sandbox profile) skips the ambient probe and uses its own pinned dir, so it
 * can NEVER discover and lock onto the production tmux server's socket dir.
 */
function resolveTmuxTmpdir(stateDir: string, socket: string, probeAmbient: boolean): string {
  const pinned = join(stateDir, "tmux");
  if (!probeAmbient) return pinned;
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const strip = (d: string) => d.replace(/\/+$/, "");
  for (const dir of [pinned, process.env.TMUX_TMPDIR, process.env.TMPDIR, "/tmp"]) {
    if (!dir) continue;
    const sock = join(strip(dir), `tmux-${uid}`, socket);
    try {
      if (statSync(sock).isSocket()) return strip(dir);
    } catch {
      /* socket not present in this candidate */
    }
  }
  return pinned;
}

export interface Runtime {
  cfg: ResolvedConfig;
  log: Logger;
  store: Store;
  tmux: Tmux;
  sessions: SessionManager;
  /** The IronCurtain sandboxed-session daemon manager; present only when enabled. */
  ironcurtain?: IronCurtainDaemon;
  close(): void;
}

/**
 * Wire the shared runtime from config: open the state store, resolve the tmux
 * binary + socket, materialize the tmux config file (the user's `tmux.configPath`
 * or the validated default), and build the session manager. Used by both the CLI
 * and the dispatcher daemon so they operate on identical state.
 */
export function createRuntime(cfg: ResolvedConfig, log: Logger = createLogger()): Runtime {
  mkdirSync(dirname(cfg.dbPath), { recursive: true });
  const store = new Store(cfg.dbPath);

  // Lock onto the live tmux server's socket dir so reconcile sees reality
  // regardless of how this process was launched (see resolveTmuxTmpdir). A custom
  // socket (test/sandbox profile) uses its own pinned dir and never probes ambient.
  const socket = cfg.tmux.socket;
  const tmuxTmpdir = resolveTmuxTmpdir(cfg.stateDir, socket, socket === DEFAULT_TMUX_SOCKET);
  mkdirSync(tmuxTmpdir, { recursive: true });
  process.env.TMUX_TMPDIR = tmuxTmpdir;

  // Resolve the tmux config file: user-provided, or write the bundled default.
  let configFile: string;
  if (cfg.tmux.configPath) {
    configFile = expandHome(cfg.tmux.configPath);
  } else {
    configFile = join(cfg.stateDir, "tmux.conf");
    mkdirSync(dirname(configFile), { recursive: true });
    writeFileSync(configFile, defaultTmuxConfig(cfg.tmux.historyLimit));
  }

  const tmux = new Tmux({
    binPath: resolveBinary("tmux") ?? "tmux",
    socket,
    configFile,
  });

  const ironcurtain = cfg.ironcurtain.enabled ? new IronCurtainDaemon(cfg.ironcurtain, log) : undefined;
  const sessions = new SessionManager(store, tmux, cfg, log, ironcurtain);

  return {
    cfg,
    log,
    store,
    tmux,
    sessions,
    ...(ironcurtain ? { ironcurtain } : {}),
    close: () => store.close(),
  };
}
