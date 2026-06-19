#!/usr/bin/env node
import { Command } from "commander";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig, type ResolvedConfig } from "../config/index.js";
import { resolveBinary, type DependencyStatus } from "../core/deps.js";
import { SwitchboardError } from "../core/errors.js";
import { Store } from "../state/db.js";
import { checkNativeModule } from "../core/native-check.js";
import { createLogger } from "../core/logger.js";
import { expandHome } from "../core/paths.js";
import { createRuntime } from "../runtime.js";
import type { Archetype, Client, Role } from "../state/types.js";
import type { CodexSandbox, ControlSurface } from "../execution/types.js";
import type { SpawnRequest } from "../execution/session.js";
import { startDaemon } from "../dispatcher/daemon.js";
import { runSession } from "../execution/claude-runner.js";
import { runStreamingSession } from "../execution/streaming-runner.js";
import { DashboardServer } from "../control/dashboard.js";
import { MemoryStore } from "../memory/memory.js";
import { MemoryService } from "../memory/service.js";
import { Coordinator } from "../coordination/coordinator.js";
import { LearnedRulesStore } from "../learning/rules.js";
import { LearningService } from "../learning/service.js";
import type { ProposalCategory } from "../state/types.js";

const PROPOSAL_CATEGORIES: ProposalCategory[] = ["convention", "task_pattern", "feedback", "policy_candidate"];

function withLearning<T>(configPath: string | undefined, fn: (svc: LearningService) => T): T {
  const cfg = loadConfig(configPath ? { path: configPath } : {});
  const store = new Store(cfg.dbPath);
  try {
    return fn(new LearningService(store, new LearnedRulesStore(cfg.stateDir)));
  } finally {
    store.close();
  }
}

function withMemory<T>(configPath: string | undefined, fn: (svc: MemoryService, ms: MemoryStore) => T): T {
  const cfg = loadConfig(configPath ? { path: configPath } : {});
  const store = new Store(cfg.dbPath);
  const ms = new MemoryStore(cfg.home);
  try {
    return fn(new MemoryService(store, ms), ms);
  } finally {
    store.close();
  }
}
import {
  installDaemon,
  uninstallDaemon,
  daemonStatus,
  renderDaemonPlist,
  DEFAULT_LABEL,
} from "../launchd/install.js";

const CLIENTS: Client[] = ["claude", "codex"];
const MODES: Archetype[] = ["deliverable", "interactive", "coordinated"];
const SURFACES: ControlSurface[] = ["tmux", "signal", "remote_control", "local_console", "ironcurtain"];
const SANDBOXES: CodexSandbox[] = ["read-only", "workspace-write", "danger-full-access"];
const ROLES: Role[] = ["implementer", "reviewer", "decider", "planner", "solo"];

function oneOf<T extends string>(label: string, value: string, allowed: readonly T[]): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new SwitchboardError(
      "bad_argument",
      `invalid ${label} '${value}' — expected one of: ${allowed.join(", ")}`,
    );
  }
  return value as T;
}

function formatAge(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

const HERE = dirname(fileURLToPath(import.meta.url));
// Example config sits at the package root in both dev (src/cli) and dist (dist/cli).
const EXAMPLE_CONFIG = resolve(HERE, "../../switchboard.config.example.json");

/** Scaffold a config from the example with a freshly generated dashboard token, owner-only (0600). */
function scaffoldConfigWithToken(dest: string): void {
  const tpl = readFileSync(EXAMPLE_CONFIG, "utf8");
  const token = randomBytes(24).toString("hex");
  const withToken = tpl.replace('"token": ""', `"token": ${JSON.stringify(token)}`);
  writeFileSync(dest, withToken, { mode: 0o600 });
}

const program = new Command();
program
  .name("switchboard")
  .description(
    "Self-hosted orchestrator for Claude Code and Codex sessions — local execution, async remote dispatch.",
  )
  .version("0.1.0");

program
  .command("init")
  .description("Scaffold the home directory, a config file, and the state database")
  .option("-c, --config <path>", "explicit config file path")
  .action((opts: { config?: string }) => {
    let cfg = loadConfig(opts.config ? { path: opts.config } : {});

    // Write the config FIRST when none exists, then re-resolve FROM it, so home,
    // stateDir, DB, and the dashboard token all land where the config says — not
    // split between cwd (the config) and the defaults (dirs/DB). Fixes the init
    // split-path quirk.
    let scaffolded: string | null = null;
    if (cfg.configPath === "<defaults>") {
      const dest = resolve(process.cwd(), "switchboard.config.json");
      if (!existsSync(dest)) {
        scaffoldConfigWithToken(dest);
        scaffolded = dest;
        cfg = loadConfig({ path: dest });
      }
    }

    // Home holds context (curated memory); stateDir holds operational state — both
    // owner-only (0700): they carry the control DB, transcripts, and the dashboard token.
    const dirs = [
      cfg.home,
      join(cfg.home, "memory"),
      join(cfg.home, "memory", "conventions"),
      cfg.stateDir,
      dirname(cfg.dbPath),
      join(cfg.stateDir, "logs"),
      join(cfg.stateDir, "scratch"),
      join(cfg.stateDir, "sessions"),
    ];
    // mkdirSync's mode only applies to NEWLY created dirs — chmod existing ones too so an
    // upgrade from an older (0755) install tightens them.
    for (const d of dirs) {
      mkdirSync(d, { recursive: true, mode: 0o700 });
      try { chmodSync(d, 0o700); } catch { /* not owner / not chmod-able */ }
    }

    // Initialize the database (applies the schema idempotently).
    const store = new Store(cfg.dbPath);
    const version = store.schemaVersion();
    store.close();
    // Tighten perms on the DB + the config (they hold the dashboard token, transcripts,
    // approvals). Best-effort: ignore if not the owner.
    try { chmodSync(cfg.dbPath, 0o600); } catch { /* ignore */ }
    if (cfg.configPath !== "<defaults>") {
      try { chmodSync(cfg.configPath, 0o600); } catch { /* ignore */ }
    }

    console.log("Switchboard initialized.");
    console.log(`  home:     ${cfg.home}`);
    console.log(`  database: ${cfg.dbPath}  (schema v${version})`);
    console.log(`  memory:   ${join(cfg.home, "memory")}`);
    if (cfg.dashboard.enabled) {
      const q = cfg.dashboard.token ? `?token=${cfg.dashboard.token}` : "";
      console.log(`  dashboard:http://${cfg.dashboard.bindAddress}:${cfg.dashboard.port}/${q}`);
    }
    if (scaffolded) {
      console.log(`\nWrote a config file to ${scaffolded} (mode 0600, with a generated dashboard token).`);
      console.log("Edit it (home dir, Signal number, asset paths, repos), then run `switchboard doctor`.");
    } else {
      console.log(`\nUsing config: ${cfg.configPath}`);
      console.log("Run `switchboard doctor` to check dependencies.");
    }
  });

program
  .command("doctor")
  .description("Validate configuration and check external dependencies")
  .option("-c, --config <path>", "explicit config file path")
  .action((opts: { config?: string }) => {
    const cfg = loadConfig(opts.config ? { path: opts.config } : {});
    console.log(`Config:   ${cfg.configPath}`);
    console.log(`Home:     ${cfg.home}`);
    console.log(`State:    ${cfg.stateDir}`);
    console.log(`Database: ${cfg.dbPath}`);
    console.log("");

    // Native-module preflight: better-sqlite3's compiled .node must match the running
    // Node ABI. Run it BEFORE opening the DB so a mismatch prints a rebuild remedy
    // instead of crashing (db.ts loads the addon lazily for exactly this reason).
    let nativeOk = true;
    try {
      checkNativeModule();
      console.log("Native:   better-sqlite3 OK");
    } catch (err) {
      nativeOk = false;
      console.log(`Native:   ✗ ${err instanceof SwitchboardError ? err.message : String(err)}`);
    }
    console.log("");

    const deps = checkDependencies(cfg);
    let missingRequired = false;
    console.log("Dependencies:");
    for (const d of deps) {
      const mark = d.path ? "✓" : d.required ? "✗" : "○";
      if (!d.path && d.required) missingRequired = true;
      const tail = d.path ?? (d.required ? "MISSING (required)" : "not found (optional)");
      console.log(`  ${mark} ${d.name.padEnd(12)} ${tail}${d.note ? `  — ${d.note}` : ""}`);
    }
    console.log("");

    // Open the database and report state (only if the native module loaded).
    if (!nativeOk) {
      console.log("State: skipped — rebuild the native module first (see Native above).");
    } else if (existsSync(cfg.dbPath)) {
      const store = new Store(cfg.dbPath);
      const count = (t: string) =>
        (store.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
      console.log("State:");
      console.log(`  schema version : ${store.schemaVersion()}`);
      console.log(`  sessions       : ${count("sessions")}`);
      console.log(`  audit events   : ${count("audit_log")}`);
      console.log(`  approvals      : ${count("approvals")}`);
      console.log(`  proposals      : ${count("memory_proposals")}`);
      store.close();
    } else {
      console.log("State: database not initialized — run `switchboard init`.");
    }
    console.log("");

    console.log("Control plane:");
    console.log(
      `  signal   : ${cfg.signal.enabled ? `enabled (account ${cfg.signal.account ?? "unset"}, ${cfg.signal.allowlist.length} allowlisted)` : "disabled — register a number, then set signal.enabled"}`,
    );
    const dashUrl = cfg.dashboard.enabled
      ? `http://${cfg.dashboard.bindAddress}:${cfg.dashboard.port}/${cfg.dashboard.token ? `?token=${cfg.dashboard.token}` : ""}`
      : "disabled";
    console.log(`  dashboard: ${dashUrl}`);

    if (missingRequired || !nativeOk) {
      console.log(
        !nativeOk
          ? "\nThe better-sqlite3 native module must be rebuilt (see Native above)."
          : "\nOne or more required dependencies are missing.",
      );
      process.exitCode = 1;
    } else {
      console.log("\nAll required dependencies present.");
    }
  });

function checkDependencies(cfg: ResolvedConfig): DependencyStatus[] {
  return [
    {
      name: "claude",
      required: cfg.clients.claude.enabled,
      path: resolveBinary("claude", cfg.clients.claude.cliPath),
      note: "Claude Code CLI (Agent SDK auth)",
    },
    {
      name: "codex",
      required: cfg.clients.codex.enabled,
      path: resolveBinary("codex", cfg.clients.codex.cliPath),
      note: cfg.clients.codex.enabled ? "Codex CLI (required for coordinate)" : "disabled in config",
    },
    { name: "tmux", required: true, path: resolveBinary("tmux") },
    {
      name: "signal-cli",
      required: cfg.signal.enabled,
      path: resolveBinary("signal-cli", cfg.signal.cliPath),
    },
    {
      name: "tailscale",
      required: false,
      path: resolveBinary("tailscale", cfg.tailscale.binPath),
      note: "for remote dashboard/attach",
    },
  ];
}

program
  .command("spawn")
  .description("Spawn a session as a detached tmux session and register it")
  .option("--client <client>", "claude | codex", "claude")
  .option("--mode <mode>", "deliverable | interactive | coordinated", "interactive")
  .option("--repo <name>", "named repo from config.repos")
  .option("--dir <path>", "explicit working directory (must exist)")
  .option("--control <surface>", "interactive control surface: tmux | signal | remote_control | local_console | ironcurtain")
  .option("--sandbox <mode>", "codex sandbox: read-only | workspace-write | danger-full-access")
  .option("--persona <name>", "ironcurtain persona (sandboxed sessions; implies --control ironcurtain)")
  .option("--role <role>", "implementer | reviewer | decider | planner | solo")
  .option("--task <text>", "task/instruction for the worker (headless sessions)")
  .option("-c, --config <path>", "explicit config file path")
  .action(
    async (opts: {
      client: string;
      mode: string;
      repo?: string;
      dir?: string;
      control?: string;
      sandbox?: string;
      persona?: string;
      role?: string;
      task?: string;
      config?: string;
    }) => {
      const cfg = loadConfig(opts.config ? { path: opts.config } : {});
      const rt = createRuntime(cfg, createLogger("warn"));
      try {
        const req: SpawnRequest = {
          client: oneOf("client", opts.client, CLIENTS),
          mode: oneOf("mode", opts.mode, MODES),
        };
        if (opts.repo) req.repo = opts.repo;
        if (opts.dir) req.workingDir = opts.dir;
        if (opts.control) req.control = oneOf("control", opts.control, SURFACES);
        if (opts.sandbox) req.sandbox = oneOf("sandbox", opts.sandbox, SANDBOXES);
        // --persona implies the ironcurtain surface (sandboxed sessions only).
        if (opts.persona) {
          req.persona = opts.persona;
          req.control = "ironcurtain";
        }
        if (opts.role) req.role = oneOf("role", opts.role, ROLES);
        if (opts.task) req.task = opts.task;

        const s = await rt.sessions.spawn(req);
        console.log(`spawned ${s.id}  (${s.client}/${s.mode}, role=${s.role})`);
        console.log(`  dir:    ${s.workingDir}`);
        // Sandboxed (IronCurtain) sessions have no tmux pane to attach — attachCommand
        // throws for them; point the operator at the dashboard's Sandboxed tab instead.
        if (s.backend === "ironcurtain") {
          console.log("  view:   sandboxed session — open the dashboard's Sandboxed tab");
        } else {
          console.log(`  attach: ${rt.sessions.attachCommand(s.id)}`);
        }
      } finally {
        rt.close();
      }
    },
  );

program
  .command("list")
  .alias("ls")
  .description("List sessions (reconciled against tmux)")
  .option("--all", "include ended sessions")
  .option("-c, --config <path>", "explicit config file path")
  .action(async (opts: { all?: boolean; config?: string }) => {
    const cfg = loadConfig(opts.config ? { path: opts.config } : {});
    const rt = createRuntime(cfg, createLogger("warn"));
    try {
      const rows = await rt.sessions.list({ active: !opts.all });
      if (rows.length === 0) {
        console.log("no sessions.");
        return;
      }
      const now = Date.now();
      console.log(
        ["ID".padEnd(10), "CLIENT".padEnd(7), "MODE".padEnd(12), "STATUS".padEnd(16), "AGE".padEnd(5), "DIR"].join(" "),
      );
      for (const s of rows) {
        console.log(
          [
            s.id.padEnd(10),
            s.client.padEnd(7),
            s.mode.padEnd(12),
            s.status.padEnd(16),
            formatAge(now - s.createdAt).padEnd(5),
            s.workingDir,
          ].join(" "),
        );
      }
    } finally {
      rt.close();
    }
  });

program
  .command("kill")
  .argument("<id>", "session id")
  .description("Kill a session (tmux + registry)")
  .option("-c, --config <path>", "explicit config file path")
  .action(async (id: string, opts: { config?: string }) => {
    const cfg = loadConfig(opts.config ? { path: opts.config } : {});
    const rt = createRuntime(cfg, createLogger("warn"));
    try {
      await rt.sessions.kill(id);
      console.log(`killed ${id}`);
    } finally {
      rt.close();
    }
  });

program
  .command("attach")
  .argument("<id>", "session id")
  .description("Print the attach command for a session")
  .option("-c, --config <path>", "explicit config file path")
  .action((id: string, opts: { config?: string }) => {
    const cfg = loadConfig(opts.config ? { path: opts.config } : {});
    const rt = createRuntime(cfg, createLogger("warn"));
    try {
      console.log(rt.sessions.attachCommand(id));
    } finally {
      rt.close();
    }
  });

program
  .command("console")
  .argument("[target]", "a repo name, an existing directory, or a short label (default: current dir)")
  .description("Start a session and attach — native Claude Code by default, or --signal for phone steering")
  .option("--signal", "Signal streaming runner (text steering + y/n approvals) instead of the native TUI")
  .option("--codex", "use codex instead of claude")
  .option("-c, --config <path>", "explicit config file path")
  .action(async (target: string | undefined, opts: { signal?: boolean; codex?: boolean; config?: string }) => {
    const cfg = loadConfig(opts.config ? { path: opts.config } : {});
    const rt = createRuntime(cfg, createLogger("warn"));
    let localAttach: string | undefined;
    try {
      const req: SpawnRequest = { client: opts.codex ? "codex" : "claude", mode: "interactive" };
      // Default = native Claude Code TUI (real UI, /model, slash commands, clean
      // exit), reachable remotely via the Tailscale/mosh attach + shown on the
      // dashboard. --signal opts into the gated streaming runner (raw chat relay,
      // but text-steerable + y/n approvals over Signal without a terminal).
      if (!opts.signal) req.control = "local_console";
      if (target && cfg.repos[target]) {
        req.repo = target;
      } else if (target && existsSync(expandHome(target))) {
        req.workingDir = target;
        req.dirHint = basename(expandHome(target));
      } else if (target) {
        req.dirHint = target;
      } else {
        req.workingDir = process.cwd();
        req.dirHint = basename(process.cwd());
      }
      const s = await rt.sessions.spawn(req);
      console.log(`spawned ${s.id}  (${s.client}/${opts.signal ? "signal-streaming" : "native console"})  in ${s.workingDir}`);
      if (opts.signal) {
        console.log(`  steer from your phone:  @${s.id} <message>   (approvals: reply  y <id>)`);
      } else {
        console.log(`  reach it from your phone:  ${rt.sessions.attachCommand(s.id)}`);
        console.log(`  native Claude Code — /model, slash commands & clean exit all work; on the dashboard`);
      }
      if (s.tmuxTarget) localAttach = rt.tmux.attachCommand(s.tmuxTarget);
    } finally {
      rt.close();
    }
    // At a real terminal: drop the operator into the pane (blocks until detach).
    // Non-interactive (scripts/tests): just print the local attach command.
    if (localAttach && process.stdout.isTTY) {
      const { spawnSync } = await import("node:child_process");
      spawnSync("/bin/sh", ["-c", localAttach], { stdio: "inherit" });
    } else if (localAttach) {
      console.log(`  attach at your desk:  ${localAttach}`);
    }
  });

program
  .command("run-session")
  .argument("<id>", "session id")
  .description("Run a gated Claude session (invoked by the dispatcher in tmux)")
  .option("--interactive", "run the long-lived streaming runner (steerable) instead of one-shot")
  .option("--resume", "resume the streaming session from its captured SDK session id")
  .option("-c, --config <path>", "explicit config file path")
  .action(async (id: string, opts: { interactive?: boolean; resume?: boolean; config?: string }) => {
    if (opts.config) process.env.SWITCHBOARD_CONFIG = opts.config;
    if (opts.interactive) await runStreamingSession(id, { resume: Boolean(opts.resume) });
    else await runSession(id);
  });

program
  .command("resume")
  .argument("<id>", "session id")
  .description("Relaunch a streaming session's runner with SDK resume (crash recovery)")
  .option("-c, --config <path>", "explicit config file path")
  .action(async (id: string, opts: { config?: string }) => {
    const cfg = loadConfig(opts.config ? { path: opts.config } : {});
    const rt = createRuntime(cfg, createLogger("warn"));
    try {
      const s = await rt.sessions.resume(id);
      console.log(`resumed ${s.id}`);
      console.log(`  attach: ${rt.sessions.attachCommand(s.id)}`);
    } finally {
      rt.close();
    }
  });

program
  .command("dashboard")
  .description("Run the control dashboard standalone (localhost; expose via tailscale serve)")
  .option("-c, --config <path>", "explicit config file path")
  .action(async (opts: { config?: string }) => {
    const cfg = loadConfig(opts.config ? { path: opts.config } : {});
    const rt = createRuntime(cfg, createLogger());
    const server = new DashboardServer({ store: rt.store, sessions: rt.sessions, tmux: rt.tmux, cfg, log: rt.log });
    const { address, port } = await server.start();
    console.log(`dashboard on http://${address}:${port}  (Ctrl-C to stop)`);
    process.on("SIGINT", () => { void server.stop().then(() => { rt.close(); process.exit(0); }); });
  });

program
  .command("daemon")
  .description("Run the dispatcher daemon in the foreground (launchd points here)")
  .option("-c, --config <path>", "explicit config file path")
  .action(async (opts: { config?: string }) => {
    if (opts.config) process.env.SWITCHBOARD_CONFIG = opts.config;
    await startDaemon();
  });

program
  .command("install-daemon")
  .description("Install and load the launchd user agent for the dispatcher")
  .option("--label <label>", "launchd label", DEFAULT_LABEL)
  .option("--dev", "run from source via tsx instead of the built dist")
  .option("--render-only", "print the plist and exit without loading anything")
  .option("-c, --config <path>", "explicit config file path")
  .action(
    async (opts: { label: string; dev?: boolean; renderOnly?: boolean; config?: string }) => {
      const cfg = loadConfig(opts.config ? { path: opts.config } : {});
      const dopts: { label?: string; dev?: boolean } = { label: opts.label };
      if (opts.dev) dopts.dev = true;
      if (opts.renderOnly) {
        process.stdout.write(renderDaemonPlist(cfg, dopts));
        return;
      }
      const res = await installDaemon(cfg, dopts);
      console.log(`installed + loaded ${res.label}`);
      console.log(`  plist: ${res.plistPath}`);
      console.log(`  logs:  ${join(cfg.stateDir, "logs")}/daemon.{out,err}.log`);
    },
  );

program
  .command("uninstall-daemon")
  .description("Unload and remove the launchd user agent")
  .option("--label <label>", "launchd label", DEFAULT_LABEL)
  .action(async (opts: { label: string }) => {
    await uninstallDaemon(opts.label);
    console.log(`uninstalled ${opts.label}`);
  });

program
  .command("daemon-status")
  .description("Show launchd state for the dispatcher")
  .option("--label <label>", "launchd label", DEFAULT_LABEL)
  .action(async (opts: { label: string }) => {
    console.log(await daemonStatus(opts.label));
  });

program
  .command("coordinate")
  .description("Run a coordinated task (Claude implements / Codex reviews / Claude decides)")
  .requiredOption("--task <text>", "the task to coordinate")
  .option("--repo <name>", "named repo from config.repos")
  .option("--dir <path>", "explicit working directory")
  .option("--max-iterations <n>", "max implement→review→revise rounds", "3")
  .option("-c, --config <path>", "explicit config file path")
  .action(async (opts: { task: string; repo?: string; dir?: string; maxIterations: string; config?: string }) => {
    const cfg = loadConfig(opts.config ? { path: opts.config } : {});
    const rt = createRuntime(cfg, createLogger("warn"));
    try {
      const coordinator = new Coordinator(rt.store, cfg, createLogger("info"));
      const auditId = rt.store.audit.append({ type: "command", source: "dashboard", payload: { coordinated: true, task: opts.task } });
      const args: Parameters<Coordinator["run"]>[0] = { task: opts.task, commandAuditId: auditId };
      if (opts.repo) args.repo = opts.repo;
      if (opts.dir) args.workingDir = opts.dir;
      const r = await coordinator.run(args);
      console.log(`\ncoordination ${r.coordinationId}: ${r.accepted ? "ACCEPTED & landed" : "not accepted (discarded)"} after ${r.iterations} round(s)`);
      console.log(`decision: ${r.decisionReasoning}`);
    } finally {
      rt.close();
    }
  });

const learnCmd = program.command("learn").description("Auto-allow learning loop — suggest, explicitly confirm, no silent drift");

learnCmd
  .command("list")
  .alias("suggestions")
  .description("List auto-allow candidates mined from approval history")
  .option("-c, --config <path>", "explicit config file path")
  .action((opts: { config?: string }) => {
    withLearning(opts.config, (svc) => {
      const candidates = svc.candidates();
      if (!candidates.length) return console.log("no auto-allow candidates yet.");
      for (const c of candidates) console.log(`${c.id}  ${c.description}`);
    });
  });

learnCmd
  .command("promote")
  .argument("<id>", "candidate id")
  .description("Promote a candidate to an auto-allow rule (audited with provenance)")
  .option("-c, --config <path>", "explicit config file path")
  .action((id: string, opts: { config?: string }) => {
    withLearning(opts.config, (svc) => {
      const r = svc.promote(id, "operator");
      console.log(`promoted: [${r.kind}] ${r.scope}  (rule ${r.id}, from ${r.sourceApprovalIds.length} approvals)`);
    });
  });

learnCmd
  .command("rules")
  .description("List active learned auto-allow rules")
  .option("-c, --config <path>", "explicit config file path")
  .action((opts: { config?: string }) => {
    withLearning(opts.config, (svc) => {
      const rules = svc.rulesList();
      if (!rules.length) return console.log("no learned rules.");
      for (const r of rules) console.log(`${r.id}  [${r.kind}]  ${r.scope}  — ${r.reason}`);
    });
  });

const memoryCmd = program.command("memory").description("Curated learning memory — children propose, you promote");

memoryCmd
  .command("list")
  .description("List pending memory proposals")
  .option("-c, --config <path>", "explicit config file path")
  .action((opts: { config?: string }) => {
    withMemory(opts.config, (svc) => {
      const pending = svc.pending();
      if (!pending.length) return console.log("no pending proposals.");
      for (const p of pending) {
        console.log(`${p.id}  [${p.category}]  session ${p.sessionId}${p.targetFile ? `  → ${p.targetFile}` : ""}`);
        console.log(`    ${p.proposedText.replace(/\s+/g, " ").slice(0, 100)}`);
      }
    });
  });

memoryCmd
  .command("show")
  .argument("[file]", "memory file to show; omit to list files")
  .description("Show curated memory files")
  .option("-c, --config <path>", "explicit config file path")
  .action((file: string | undefined, opts: { config?: string }) => {
    withMemory(opts.config, (_svc, ms) => {
      if (file) console.log(ms.read(file) || "(empty or not found)");
      else {
        const files = ms.listFiles();
        console.log(files.length ? files.join("\n") : "(no memory files yet)");
      }
    });
  });

const resolvePrefix = (svc: MemoryService, idOrPrefix: string): string =>
  svc.pending().find((p) => p.id.startsWith(idOrPrefix))?.id ?? idOrPrefix;

memoryCmd
  .command("promote")
  .argument("<id>", "proposal id (or unique prefix)")
  .description("Promote a proposal into shared memory (audited with provenance)")
  .option("-c, --config <path>", "explicit config file path")
  .action((id: string, opts: { config?: string }) => {
    withMemory(opts.config, (svc) => {
      const r = svc.promote(resolvePrefix(svc, id), "operator");
      console.log(`promoted → ${r.file}`);
    });
  });

memoryCmd
  .command("reject")
  .argument("<id>", "proposal id (or unique prefix)")
  .description("Reject a proposal")
  .option("-c, --config <path>", "explicit config file path")
  .action((id: string, opts: { config?: string }) => {
    withMemory(opts.config, (svc) => {
      svc.reject(resolvePrefix(svc, id));
      console.log("rejected");
    });
  });

memoryCmd
  .command("propose")
  .description("Record a proposal (used by child sessions; also handy for testing)")
  .requiredOption("--session <id>", "originating session id")
  .requiredOption("--category <category>", "convention | task_pattern | feedback | policy_candidate")
  .requiredOption("--text <text>", "the proposed memory text")
  .option("--file <relpath>", "target memory file (must stay under memory/)")
  .option("-c, --config <path>", "explicit config file path")
  .action((opts: { session: string; category: string; text: string; file?: string; config?: string }) => {
    withMemory(opts.config, (svc) => {
      const category = oneOf("category", opts.category, PROPOSAL_CATEGORIES);
      const r = svc.propose({ sessionId: opts.session, category, proposedText: opts.text, targetFile: opts.file ?? null });
      console.log(`proposed ${r.id}`);
    });
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  if (err instanceof SwitchboardError) {
    console.error(`error [${err.code}]: ${err.message}`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
