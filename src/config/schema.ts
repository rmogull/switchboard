import { z } from "zod";

/**
 * Configuration schema. EVERYTHING environment-specific lives here so the code
 * itself carries no personal facts — that is what makes Switchboard packageable
 * and releasable. A fresh install ships `switchboard.config.example.json`; a
 * user copies it, fills in their own home dir, Signal number, asset paths, and
 * repo registry, and nothing in `src/` needs to change.
 */

const clientConfig = z.object({
  /** If false, this client is unavailable and spawning it errors clearly. */
  enabled: z.boolean().default(true),
  /** Absolute path to the CLI binary. Resolved from PATH when omitted. */
  cliPath: z.string().optional(),
});

const signalConfig = z.object({
  /** Off until a dedicated number is registered with signal-cli. */
  enabled: z.boolean().default(false),
  /** The registered signal-cli account (the dedicated number), E.164. */
  account: z.string().optional(),
  /**
   * Hard sender allowlist (Invariant 2). Only messages from these E.164 numbers
   * are ever parsed as commands; everything else is audit-logged and dropped.
   */
  allowlist: z.array(z.string()).default([]),
  cliPath: z.string().optional(),
});

const dashboardConfig = z.object({
  enabled: z.boolean().default(true),
  port: z.number().int().min(1).max(65535).default(8765),
  /** Bind localhost only; reach it remotely via `tailscale serve`, never a public port. */
  bindAddress: z.string().default("127.0.0.1"),
  /**
   * Bearer token required on every `/api` route. The dashboard REFUSES to start when
   * it is exposed beyond loopback (a non-loopback `bindAddress` or `tailscale.serve`)
   * without one — any device that can reach the port is otherwise a full operator
   * (it can kill sessions, decide approvals, spawn sandboxed sessions). `init`
   * generates one; open the dashboard once as `https://<host>/?token=<token>`.
   */
  token: z.string().optional(),
});

const tailscaleConfig = z.object({
  /** The GUI app ships the CLI here on macOS; it is not on PATH by default. */
  binPath: z
    .string()
    .default("/Applications/Tailscale.app/Contents/MacOS/Tailscale"),
  /** Whether to expose the dashboard via `tailscale serve` on the tailnet. */
  serve: z.boolean().default(false),
});

const tmuxConfig = z.object({
  /** One tmux session per Switchboard session, named `<prefix>:<id>` (§9). */
  sessionPrefix: z.string().default("sw"),
  historyLimit: z.number().int().default(50000),
  /** Path to a tmux config applied to created sessions; bundled default if omitted. */
  configPath: z.string().optional(),
  /**
   * tmux server socket name (`tmux -L <socket>`). Leave the default for normal use.
   * A SEPARATE Switchboard profile on the SAME machine (e.g. a throwaway test config)
   * MUST set a distinct socket here so it never shares the production tmux server or
   * reconciles against — and kills — the production panes.
   */
  socket: z.string().default("switchboard"),
});

const attachConfig = z.object({
  /**
   * Remote target for phone/iPad attach (e.g. "user@host.tailnet.ts.net"). When
   * set, attach commands are wrapped to reach the Mac over the tailnet. Unset →
   * the bare local tmux command.
   */
  sshHost: z.string().optional(),
  /**
   * Transport for remote attach. "mosh" (default) survives phone sleep + network
   * roaming and gives local-echo typing — the right default for a mobile operator.
   * "ssh" falls back to `ssh <host> -t '<tmux attach>'` if mosh isn't available.
   */
  transport: z.enum(["mosh", "ssh"]).default("mosh"),
  /**
   * Absolute path to mosh-server on the Mac, injected as `mosh --server=<path>`.
   * A non-login SSH session's PATH usually omits Homebrew's bin, so mosh can't
   * find mosh-server by name — this makes the connection string self-contained.
   */
  moshServerPath: z.string().default("/opt/homebrew/bin/mosh-server"),
  /**
   * Name of the saved Panic Prompt favorite that the dashboard's "Open in Prompt"
   * deep link launches (`prompt-favorite://<promptFavorite>`). Configure that
   * favorite on the phone with mosh enabled + the dedicated attach key; the
   * Mac-side ForceCommand then drops you into the most-recently-used session.
   * Per-session targeting isn't possible via Prompt's URL scheme — it attaches
   * the latest; the per-session mosh command is offered separately for copy.
   */
  promptFavorite: z.string().default("switchboard"),
});

const approvalsConfig = z.object({
  /** How long a blocking tool call waits for an out-of-band decision (§5.5). */
  timeoutMs: z.number().int().positive().default(120_000),
  /** Fail closed: an unanswered approval denies the action. */
  onTimeout: z.literal("deny").default("deny"),
});

const retentionConfig = z.object({
  /**
   * Age out (purge) TERMINAL sessions — done/failed/killed — older than this many
   * days, along with their scratch dirs, transcript, and steering/outbound/approval
   * rows. The append-only audit_log is PRESERVED (it is the security record), and
   * each purge is itself recorded there. Active sessions are never aged out. Set 0
   * to disable retention entirely.
   */
  sessionDays: z.number().int().nonnegative().default(30),
});

/** Per-action default: allow outright, deny outright, or ask out-of-band. */
const decision = z.enum(["allow", "deny", "ask"]);

const policyConfig = z.object({
  /**
   * Overrides for the default permission matrix (§5.5). Keys are policy action
   * names (e.g. "write_outside_workdir", "delete", "network_egress"); the code
   * ships safe defaults and merges these on top.
   */
  overrides: z.record(z.string(), decision).default({}),
  /** Domains auto-allowed for egress across all sessions (per-session adds more). */
  egressAllowlist: z.array(z.string()).default([]),
});

/**
 * IronCurtain (provos) sandboxed-execution backend (opt-in). Switchboard launches
 * one long-lived `ironcurtain daemon --no-signal --web-ui` and creates Docker-
 * sandboxed sessions over its localhost web-ui WS, bridging escalations into the
 * normal approval→Signal path. See docs/plans/2026-06-17-ironcurtain-backend-*.
 */
const ironcurtainConfig = z.object({
  /** Off by default — the sandboxed-session backend is opt-in. */
  enabled: z.boolean().default(false),
  /**
   * Node interpreter used to launch IronCurtain. MUST be node@24: IronCurtain's
   * isolated-vm has no node-26 prebuild, and under node 26 the V8 sandbox SILENTLY
   * disables (a security-critical failure). The daemon manager verifies this
   * interpreter's major version before trusting the sandbox.
   */
  nodePath: z.string().default("/opt/homebrew/opt/node@24/bin/node"),
  /** Absolute path to the installed `ironcurtain` entry (run via nodePath, not its own shebang). */
  binPath: z.string().default("/opt/homebrew/bin/ironcurtain"),
  /** Web-UI WS port the daemon binds (`--web-port`). */
  webPort: z.number().int().min(1).max(65535).default(7400),
  /** Endpoint state file the daemon writes ({port,host,token}); a leading '~' is expanded. */
  stateFile: z.string().default("~/.ironcurtain/web-ui.json"),
  /** Root holding the hand-authored, pre-compiled personas (one dir per persona). */
  personasDir: z.string().default("~/.ironcurtain/personas"),
  /** Pin host/port/token explicitly (e.g. when the daemon runs as another user); else discovered from stateFile. */
  endpoint: z
    .object({ host: z.string(), port: z.number().int(), token: z.string() })
    .optional(),
  /** Persona used when a sandboxed session is spawned without an explicit one. */
  defaultPersona: z.string().optional(),
  /** Mirror of IronCurtain's hardcoded web-session cap; pre-checked before sessions.create. */
  maxWebSessions: z.number().int().positive().default(5),
});

export const configSchema = z.object({
  /**
   * Runtime home directory — the working memory + skills root the dispatcher
   * operates on (e.g. an existing productivity/notes directory). Overridable by the
   * SWITCHBOARD_HOME env var.
   */
  home: z.string().default("~/.switchboard"),
  /**
   * Operational state directory (db, scratch, sessions, logs, tmux config,
   * learned rules). Defaults to `<home>/switchboard`. Set this OUTSIDE the home
   * when home is an iCloud/Dropbox-synced folder — a live SQLite WAL database and
   * git-based coordination scratch must not be sync-managed (corruption/eviction).
   */
  stateDir: z.string().optional(),
  /** SQLite state file. Defaults to `<stateDir>/switchboard.db`. */
  dbPath: z.string().optional(),
  clients: z
    .object({ claude: clientConfig, codex: clientConfig })
    .prefault({ claude: {}, codex: {} }),
  signal: signalConfig.prefault({}),
  dashboard: dashboardConfig.prefault({}),
  tailscale: tailscaleConfig.prefault({}),
  tmux: tmuxConfig.prefault({}),
  approvals: approvalsConfig.prefault({}),
  retention: retentionConfig.prefault({}),
  attach: attachConfig.prefault({}),
  policy: policyConfig.prefault({}),
  /** IronCurtain sandboxed-execution backend (opt-in; see ironcurtainConfig). */
  ironcurtain: ironcurtainConfig.prefault({}),
  /** Named asset/template paths (e.g. "deckTemplate", "iconLibrary"). */
  assets: z.record(z.string(), z.string()).default({}),
  /** Known repositories by short name → absolute path (e.g. "myproject"). */
  repos: z.record(z.string(), z.string()).default({}),
  /** Roots searched (2 levels deep) to resolve a project by name when it isn't in `repos`. */
  codeRoots: z.array(z.string()).default([]),
  paths: z
    .object({
      /** Synced cloud output folder for deliverables (write = ask). */
      driveOutput: z.string().optional(),
    })
    .prefault({}),
});

export type SwitchboardConfig = z.infer<typeof configSchema>;
export type PolicyDecision = z.infer<typeof decision>;
