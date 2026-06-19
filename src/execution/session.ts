import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ResolvedConfig } from "../config/index.js";
import type { Logger } from "../core/logger.js";
import type { Store } from "../state/db.js";
import type { Archetype, Client, Role, SessionBackend, SessionRow } from "../state/types.js";
import { idSuffix, shortId } from "../core/ids.js";
import { expandHome } from "../core/paths.js";
import { SwitchboardError } from "../core/errors.js";
import { cliInvocationArgs, shellJoin } from "../core/self-invoke.js";
import { findProjectDir } from "../dispatcher/find-project.js";
import { Tmux } from "./tmux.js";
import type { ControlSurface, CodexSandbox } from "./types.js";
import type { IronCurtainDaemon } from "./ironcurtain/daemon.js";

/** Parse the `{"label":N}` IronCurtain handle persisted on a sandboxed session row. */
function parseIcLabel(backendHandle: string | null): number | undefined {
  if (!backendHandle) return undefined;
  try {
    const h = JSON.parse(backendHandle) as { label?: unknown };
    return typeof h.label === "number" ? h.label : undefined;
  } catch {
    return undefined;
  }
}

// Words dropped when deriving a descriptive slug from a task — articles,
// pronouns, fillers, and common spawn verbs — so the slug keeps the meaningful nouns.
const ID_STOPWORDS = new Set([
  "the", "a", "an", "my", "your", "our", "this", "that", "these", "those", "it", "its",
  "i", "me", "we", "you", "he", "she", "they", "new", "session", "claude", "codex",
  "please", "can", "could", "would", "help", "need", "want", "start", "launch", "create",
  "make", "build", "run", "spin", "set", "open", "get", "go", "check", "checks", "checking",
  "identify", "identifies", "find", "show", "tell", "look", "see", "review", "and", "or",
  "of", "for", "to", "in", "on", "at", "with", "from", "by", "so", "which", "any", "some",
  "all", "might", "may", "be", "is", "are", "am", "do", "does", "up", "out", "task", "tasks",
  "thing", "things", "stuff", "let", "about",
]);

/**
 * Pre-accept Claude Code's per-directory "trust the files in this folder?" dialog
 * for `dir` (set hasTrustDialogAccepted in ~/.claude.json), so a CONVERTED native
 * session — which respawns DETACHED — starts without blocking on that prompt until
 * the operator attaches. Best-effort: a missing/unparseable config (or a write
 * failure) is left alone and the dialog simply reappears on attach. Consistent with
 * convert's intent: the operator has explicitly opted into the native, trusted CLI
 * surface. Returns true if the dir is now trusted.
 */
export function trustClaudeDir(dir: string, claudeJsonPath = join(homedir(), ".claude.json")): boolean {
  try {
    if (!existsSync(claudeJsonPath)) return false;
    const cfg = JSON.parse(readFileSync(claudeJsonPath, "utf8")) as {
      projects?: Record<string, Record<string, unknown>>;
    };
    cfg.projects ??= {};
    const entry = cfg.projects[dir] ?? {};
    if (entry.hasTrustDialogAccepted === true) return true; // already trusted — no write
    entry.hasTrustDialogAccepted = true;
    cfg.projects[dir] = entry;
    writeFileSync(claudeJsonPath, JSON.stringify(cfg, null, 2));
    return true;
  } catch {
    return false;
  }
}

function slugify(s: string, max = 16): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, max)
    .replace(/-+$/, "");
}

function taskKeywords(task: string): string {
  const words = task
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !ID_STOPWORDS.has(w));
  return words.slice(0, 2).join("-");
}

/**
 * Derive a human-readable, descriptive slug for a session id from the spawn
 * request: the repo name, else 'coord' for coordinated, else a directory hint,
 * else the task's first meaningful keywords. Sanitized for tmux/shell safety; a
 * disambiguator suffix (added by the caller) keeps the full id unique.
 */
export function sessionSlug(req: SpawnRequest): string {
  let base = "";
  if (req.repo) base = req.repo;
  else if (req.mode === "coordinated") base = "coord";
  else if (req.dirHint) base = req.dirHint;
  else if (req.task) base = taskKeywords(req.task);
  return slugify(base) || "task";
}

export interface SpawnRequest {
  client: Client;
  mode: Archetype;
  role?: Role;
  /** Named repo from config.repos (mutually exclusive with workingDir). */
  repo?: string;
  /** Explicit working directory (must exist). */
  workingDir?: string;
  /** A project NAME to search for under config.codeRoots when not a known repo. */
  dirHint?: string;
  /** Interactive control surface; defaults to tmux. */
  control?: ControlSurface;
  /** Codex sandbox scope; defaults to workspace-write. */
  sandbox?: CodexSandbox;
  egressAllowlist?: string[];
  /** The instruction for the worker (persisted for the headless runner to read). */
  task?: string;
  /** Advanced: override the launched command entirely. */
  command?: string;
  /** IronCurtain persona (profile) for a sandboxed session; defaults to cfg.ironcurtain.defaultPersona. */
  persona?: string;
}

/**
 * Spawns and tracks execution sessions (spec §5.4). Every session is a detached
 * tmux session on Switchboard's dedicated server, isolated to its own working
 * directory, with a registry row that is the source of truth for the dashboard
 * and `switchboard list`. The registry — not the agent — is authoritative.
 */
export class SessionManager {
  constructor(
    private readonly store: Store,
    private readonly tmux: Tmux,
    private readonly cfg: ResolvedConfig,
    private readonly log: Logger,
    /** Present only when cfg.ironcurtain.enabled — owns the sandboxed-session daemon. */
    private readonly ic?: IronCurtainDaemon,
  ) {}

  private sessionName(id: string): string {
    return `${this.cfg.tmux.sessionPrefix}-${id}`;
  }

  /** A descriptive, unique session id: `<slug>-<suffix>` (e.g. `sip-k4p`). */
  private newSessionId(req: SpawnRequest): string {
    const slug = sessionSlug(req);
    for (let i = 0; i < 8; i++) {
      const id = `${slug}-${idSuffix(3)}`;
      if (!this.store.sessions.get(id)) return id;
    }
    return `${slug}-${shortId()}`; // collision-proof fallback (effectively never hit)
  }

  private resolveWorkingDir(req: SpawnRequest, id: string): string {
    if (req.repo) {
      const p = this.cfg.repos[req.repo];
      if (!p) {
        throw new SwitchboardError(
          "unknown_repo",
          `no repo '${req.repo}' in config.repos`,
        );
      }
      const dir = expandHome(p);
      if (!existsSync(dir)) {
        throw new SwitchboardError("missing_dir", `repo '${req.repo}' path does not exist: ${dir}`);
      }
      return dir;
    }
    if (req.workingDir) {
      const dir = expandHome(req.workingDir);
      if (!existsSync(dir)) {
        throw new SwitchboardError("missing_dir", `working dir does not exist: ${dir}`);
      }
      return dir;
    }
    // Resolve a project by name under the configured code roots (§5.1).
    if (req.dirHint) {
      const found = findProjectDir(req.dirHint, this.cfg.codeRoots);
      if (found) return found;
      this.log.info("project search found no match; using scratch", { dirHint: req.dirHint });
    }
    // Ad-hoc / deliverable: an isolated scratch dir under the (non-synced) state dir.
    const dir = join(this.cfg.stateDir, "scratch", id);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * Build the pane command. tmux runs this string via the shell, so it must
   * contain no untrusted interpolation — here every fragment is a fixed flag or
   * an enum value, never a path or task text (paths go through tmux's `-c`).
   */
  private buildCommand(req: SpawnRequest, id: string): string {
    if (req.command) return req.command;
    if (req.client === "claude") {
      // Headless deliverable/coordinated runs the gated SDK runner (canUseTool →
      // policy → Signal approvals).
      if (req.mode === "deliverable" || req.mode === "coordinated") {
        return shellJoin(cliInvocationArgs(["run-session", id]));
      }
      // Interactive Claude. The REMOTE DEFAULT is the gated SDK streaming runner —
      // tool-use is policed and prompts route to Signal/dashboard/pane. Raw CLI is
      // only for the explicit at-desk console / official-app surfaces (NOT gated).
      if (req.control === "local_console") {
        return this.cfg.clients.claude.cliPath ?? "claude";
      }
      if (req.control === "remote_control") {
        return `${this.cfg.clients.claude.cliPath ?? "claude"} --remote-control`;
      }
      return shellJoin(cliInvocationArgs(["run-session", id, "--interactive"]));
    }
    const bin = this.cfg.clients.codex.cliPath ?? "codex";
    const sandbox = req.sandbox ?? "workspace-write";
    // Headless deliverable/coordinated Codex: actually RUN the task to completion via
    // `codex exec`, sandbox + approval_policy pinned (the autonomous contract). The task
    // text is read from the persisted task.md at run time through `"$(cat …)"` — passed as
    // a single quoted arg, NEVER interpolated into this shell string (only the controlled
    // session path is). Bare interactive `codex` is reserved for an attached session.
    if (req.task && (req.mode === "deliverable" || req.mode === "coordinated")) {
      // POSIX single-quote escape (`'` → `'\''`) so a stateDir containing a quote can't
      // break out of the `cat` substitution. The task TEXT is read from disk at run time
      // (never interpolated into this string), so only the controlled path appears here.
      const taskPath = join(this.cfg.stateDir, "sessions", id, "task.md").replace(/'/g, "'\\''");
      return `${bin} exec -c sandbox_mode=${sandbox} -c approval_policy=never "$(cat '${taskPath}')"`;
    }
    return `${bin} -c sandbox_mode=${sandbox}`;
  }

  /** The executor backend for a spawn — drives output transport + reconcile semantics. */
  private backendFor(req: SpawnRequest): SessionBackend {
    if (req.control === "ironcurtain") return "ironcurtain";
    if (req.client === "codex") return "codex_cli";
    if (req.mode === "deliverable" || req.mode === "coordinated") return "claude_sdk";
    return req.control === "local_console" || req.control === "remote_control"
      ? "claude_cli_console"
      : "claude_sdk_stream";
  }

  async spawn(req: SpawnRequest): Promise<SessionRow> {
    if (req.control === "ironcurtain") return this.spawnIronCurtain(req);
    if (req.client === "claude" && !this.cfg.clients.claude.enabled) {
      throw new SwitchboardError("client_disabled", "claude client is disabled in config");
    }
    if (req.client === "codex" && !this.cfg.clients.codex.enabled) {
      throw new SwitchboardError("client_disabled", "codex client is disabled in config");
    }

    const id = this.newSessionId(req);
    const name = this.sessionName(id);
    const workingDir = this.resolveWorkingDir(req, id);
    const role: Role = req.role ?? (req.mode === "coordinated" ? "planner" : "solo");

    const row = this.store.sessions.create({
      id,
      client: req.client,
      mode: req.mode,
      role,
      workingDir,
      tmuxTarget: name,
      status: "starting",
      egressAllowlist: req.egressAllowlist ?? null,
      backend: this.backendFor(req),
    });
    this.store.audit.append({
      type: "spawn",
      source: "dispatcher",
      sessionId: id,
      payload: {
        client: req.client,
        mode: req.mode,
        role,
        workingDir,
        control: req.control ?? "tmux",
        tmuxTarget: name,
      },
    });

    // Persist the task so the headless runner can read it back.
    if (req.task) {
      const sdir = join(this.cfg.stateDir, "sessions", id);
      mkdirSync(sdir, { recursive: true });
      writeFileSync(join(sdir, "task.md"), req.task);
    }

    try {
      await this.tmux.newSession({
        name,
        cwd: workingDir,
        command: this.buildCommand(req, id),
      });
    } catch (err) {
      this.store.sessions.setStatus(id, "failed");
      this.store.audit.append({
        type: "error",
        source: "dispatcher",
        sessionId: id,
        payload: { stage: "tmux_new_session", error: String(err) },
      });
      throw err;
    }

    this.store.sessions.setStatus(id, "running");
    this.log.info("session spawned", { id, client: req.client, mode: req.mode, name });
    return this.store.sessions.get(id)!;
  }

  async kill(id: string): Promise<void> {
    const s = this.store.sessions.get(id);
    if (!s) throw new SwitchboardError("unknown_session", `no session '${id}'`);
    if (s.backend === "ironcurtain") {
      const label = parseIcLabel(s.backendHandle);
      if (label !== undefined && this.ic?.client) {
        await this.ic.client.end(label).catch(() => {
          /* best-effort; reconcile catches a stuck session */
        });
      }
    } else if (s.tmuxTarget) {
      await this.tmux.killSession(s.tmuxTarget);
    }
    this.store.sessions.setStatus(id, "killed");
    // The runner is dead, so its in-process approval-gateway poll can never
    // resolve any pending approvals — fail-close them so they don't linger as
    // stale 'pending' rows (which would pollute audit/learning and could later be
    // accepted by a bare 'y').
    this.failClosePendingApprovals(id, "session killed");
    this.store.audit.append({
      type: "status_change",
      source: "dispatcher",
      sessionId: id,
      payload: { status: "killed" },
    });
    this.log.info("session killed", { id });
  }

  /**
   * Timeout-deny a session's pending approvals. Used when a session is killed or
   * its runner vanished: the gateway poll that would otherwise resolve them is
   * gone, so leaving them 'pending' is a leak (Invariant 7 — fail closed).
   */
  private failClosePendingApprovals(sessionId: string, reason: string): void {
    for (const a of this.store.approvals.listPending()) {
      if (a.sessionId !== sessionId) continue;
      if (this.store.approvals.decide(a.id, "timeout", "policy_auto")) {
        this.store.audit.append({
          type: "approval_decision",
          source: "dispatcher",
          sessionId,
          payload: { id: a.id, status: "timeout", via: "policy_auto", reason },
        });
      }
    }
  }

  /**
   * Spawn a Docker-sandboxed session on the shared IronCurtain daemon. No tmux
   * pane: the session is created + driven over the daemon's web-ui WS and tracked
   * by a registry row (backend 'ironcurtain', tmux_target NULL). The persona
   * governs the sandbox policy + workspace; escalations are bridged to Signal by
   * the EscalationBridge.
   */
  private async spawnIronCurtain(req: SpawnRequest): Promise<SessionRow> {
    if (!this.cfg.ironcurtain.enabled || !this.ic) {
      throw new SwitchboardError("ironcurtain_disabled", "ironcurtain backend is disabled in config");
    }
    const id = this.newSessionId(req);
    const workingDir = this.resolveWorkingDir(req, id);
    const role: Role = req.role ?? "solo";
    const persona = req.persona ?? this.cfg.ironcurtain.defaultPersona;

    const client = await this.ic.ensure();
    let activeCount: number;
    try {
      activeCount = (await client.listLabels()).length;
    } catch {
      activeCount = 0;
    }
    if (activeCount >= this.cfg.ironcurtain.maxWebSessions) {
      throw new SwitchboardError(
        "capacity",
        `ironcurtain web-session cap (${this.cfg.ironcurtain.maxWebSessions}) reached`,
      );
    }

    this.store.sessions.create({
      id,
      client: req.client,
      mode: req.mode,
      role,
      workingDir,
      tmuxTarget: null,
      status: "starting",
      egressAllowlist: req.egressAllowlist ?? null,
      backend: "ironcurtain",
    });
    this.store.audit.append({
      type: "spawn",
      source: "dispatcher",
      sessionId: id,
      payload: { client: req.client, mode: req.mode, role, workingDir, control: "ironcurtain", persona: persona ?? null },
    });

    try {
      const label = await client.createSession(persona);
      this.store.sessions.setIronCurtainHandle(id, label, persona);
      if (req.task) await client.send(label, req.task);
    } catch (err) {
      this.store.sessions.setStatus(id, "failed");
      this.store.audit.append({
        type: "error",
        source: "dispatcher",
        sessionId: id,
        payload: { stage: "ironcurtain_create", error: String(err) },
      });
      throw err;
    }

    this.store.sessions.setStatus(id, "running");
    this.log.info("ironcurtain session spawned", { id, persona: persona ?? null });
    return this.store.sessions.get(id)!;
  }

  /**
   * Reconcile active sandboxed (ironcurtain) rows against the daemon's live
   * session list — the WS analogue of the tmux reconcile in list(). Adopts a
   * still-running daemon (never spawns one here); if the daemon is unreachable,
   * every active sandboxed row is failed and its pending approvals fail-closed
   * (Invariant 7). Otherwise a row whose label is absent from the live set ended.
   */
  private async reconcileIronCurtain(): Promise<void> {
    if (!this.ic) return;
    const icRows = this.store.sessions
      .list({ active: true })
      .filter((s) => s.backend === "ironcurtain");
    if (icRows.length === 0) return;

    let liveLabels: Set<number> | undefined;
    try {
      const client = this.ic.client ?? (await this.ic.adopt());
      liveLabels = client ? new Set(await client.listLabels()) : undefined;
    } catch (err) {
      this.log.warn("ironcurtain reconcile: daemon unreachable", { err: String(err) });
      liveLabels = undefined;
    }

    for (const s of icRows) {
      if (liveLabels === undefined) {
        this.store.sessions.setStatus(s.id, "failed");
        this.store.audit.append({
          type: "status_change",
          source: "dispatcher",
          sessionId: s.id,
          payload: { status: "failed", reason: "ironcurtain daemon unreachable" },
        });
        this.failClosePendingApprovals(s.id, "ironcurtain daemon unreachable");
        continue;
      }
      const label = parseIcLabel(s.backendHandle);
      if (label === undefined || !liveLabels.has(label)) {
        this.store.sessions.setStatus(s.id, "done");
        this.store.audit.append({
          type: "status_change",
          source: "dispatcher",
          sessionId: s.id,
          payload: { status: "done", reason: "ironcurtain session ended" },
        });
      }
    }
  }

  /**
   * Relaunch a streaming session's runner with SDK resume from its captured
   * claude_session_id (operator-gated crash recovery). Only valid for a
   * claude_sdk_stream session that captured an SDK session id.
   */
  async resume(id: string): Promise<SessionRow> {
    const s = this.store.sessions.get(id);
    if (!s) throw new SwitchboardError("unknown_session", `no session '${id}'`);
    if (s.backend !== "claude_sdk_stream") {
      throw new SwitchboardError("not_resumable", `session '${id}' is not a resumable streaming session`);
    }
    if (!s.claudeSessionId) {
      throw new SwitchboardError("no_resume", `session '${id}' has no captured SDK session to resume`);
    }
    // Only a FAILED (crashed) session is resumable — never an active one (would
    // clobber the live pane) nor an intentionally-ended done/killed one.
    if (s.status !== "failed") {
      throw new SwitchboardError("not_resumable", `session '${id}' is ${s.status}; only a failed session can be resumed`);
    }
    const name = s.tmuxTarget ?? this.sessionName(id);
    const live = new Set(await this.tmux.listSessions());
    if (live.has(name)) {
      throw new SwitchboardError("not_resumable", `session '${id}' still has a live pane`);
    }
    await this.tmux.newSession({
      name,
      cwd: s.workingDir,
      command: shellJoin(cliInvocationArgs(["run-session", id, "--interactive", "--resume"])),
    });
    this.store.sessions.setTmuxTarget(id, name);
    this.store.sessions.reopenRunning(id); // running + clears the stale ended_at
    this.store.audit.append({
      type: "status_change",
      source: "dispatcher",
      sessionId: id,
      payload: { event: "resume" },
    });
    this.log.info("session resumed", { id });
    return this.store.sessions.get(id)!;
  }

  /**
   * Convert a live GATED SDK streaming session into a NATIVE `claude` CLI session
   * IN PLACE — same pane, same cwd — by resuming its captured SDK session id
   * (`claude --resume <claude_session_id>`). The conversation continues seamlessly
   * (the SDK persists the transcript to ~/.claude/projects, which `--resume` reads);
   * the same cwd is what lets resume find it.
   *
   * This is a DELIBERATE security posture change: the converted session is no longer
   * behind Switchboard's policy/approval gate — the native CLI handles permissions
   * in-TTY — so the transition is recorded in the append-only audit_log and the
   * session's orphaned pending approvals are fail-closed (the SDK runner's in-process
   * approval poll dies with it, exactly as on kill). One-way (SDK→native) by design.
   *
   * Convert when the session is idle for a lossless handoff: the SDK writes the
   * transcript incrementally, so an idle session is fully flushed; converting
   * mid-response drops only the in-flight turn.
   */
  async convertToNative(id: string, opts: { remoteControl?: boolean } = {}): Promise<SessionRow> {
    const s = this.store.sessions.get(id);
    if (!s) throw new SwitchboardError("unknown_session", `no session '${id}'`);
    if (s.backend !== "claude_sdk_stream") {
      throw new SwitchboardError("not_convertible", `session '${id}' is not a gated streaming session`);
    }
    if (!s.claudeSessionId) {
      throw new SwitchboardError("no_resume", `session '${id}' has no captured SDK session to resume`);
    }
    if (["done", "failed", "killed"].includes(s.status)) {
      throw new SwitchboardError("not_convertible", `session '${id}' is ${s.status}; only a live session can be converted`);
    }
    if (!s.tmuxTarget) throw new SwitchboardError("not_convertible", `session '${id}' has no pane`);
    const live = new Set(await this.tmux.listSessions());
    if (!live.has(s.tmuxTarget)) {
      throw new SwitchboardError("not_convertible", `session '${id}' has no live pane`);
    }

    const bin = this.cfg.clients.claude.cliPath ?? "claude";
    const rc = opts.remoteControl ? " --remote-control" : "";
    // claude_session_id is an SDK-issued UUID, but single-quote it defensively.
    const sid = s.claudeSessionId.replace(/'/g, "'\\''");
    const command = `${bin}${rc} --resume '${sid}'`;

    // Audit the posture change BEFORE the side effect (gated → ungated, Invariant 6).
    this.store.audit.append({
      type: "status_change",
      source: "dispatcher",
      sessionId: id,
      payload: {
        event: "convert_to_native",
        from: "claude_sdk_stream",
        to: "claude_cli_console",
        remoteControl: !!opts.remoteControl,
        claudeSessionId: s.claudeSessionId,
      },
    });
    // The SDK runner is about to die; its in-process approval poll dies with it, so
    // any pending approvals must be fail-closed (same as kill()).
    this.failClosePendingApprovals(id, "converted to native CLI");
    // Pre-accept the per-dir trust dialog so the DETACHED native session starts
    // clean (otherwise `claude` blocks on "trust this folder?" until the operator
    // attaches — which also stalls `--remote-control` from engaging).
    const trusted = trustClaudeDir(s.workingDir);
    if (!trusted) {
      this.log.warn("could not pre-trust working dir; native session may prompt for folder trust on attach", { id, dir: s.workingDir });
    }
    // Respawn the SAME pane (same cwd → --resume finds the transcript) as native claude.
    await this.tmux.respawnPane(s.tmuxTarget, command, s.workingDir);
    // Flip the backend so reconcile treats a vanished pane as 'done' (native CLI does
    // not self-report) and the dashboard reads the pane capture, not the transcript.
    this.store.sessions.setBackend(id, "claude_cli_console");
    this.store.sessions.setStatus(id, "running");
    this.log.info("session converted to native CLI", { id, remoteControl: !!opts.remoteControl });
    return this.store.sessions.get(id)!;
  }

  /**
   * List sessions, reconciling registry against tmux: an active session whose
   * tmux session has vanished is resolved to a terminal state so `list` and the
   * dashboard reflect reality rather than stale "running" rows.
   *
   * How a vanished pane is interpreted depends on whether the session's executor
   * self-reports its terminal status before exiting:
   *   - deliverable/coordinated run the SDK runner, which sets done/failed itself.
   *     If such a session is STILL ACTIVE here, it did not finish cleanly — it
   *     crashed. Mark it failed and fail-close its orphaned pending approvals
   *     (the in-process approval-gateway poll died with the runner, so nothing
   *     else will ever resolve them).
   *   - interactive runs the raw `claude` CLI, which never sets a terminal status;
   *     a vanished pane is the NORMAL way the operator ends it — mark it done.
   * (When interactive moves to the SDK streaming runner it will also self-report,
   * and should join the self-reporting set below.)
   */
  async list(opts: { active?: boolean } = {}): Promise<SessionRow[]> {
    const live = new Set(await this.tmux.listSessions());
    for (const s of this.store.sessions.list({ active: true })) {
      if (!s.tmuxTarget || live.has(s.tmuxTarget)) continue;
      // Self-reporting = runs an SDK runner that sets its own terminal status, so
      // a still-active vanished session crashed. Prefer the explicit backend;
      // fall back to mode for legacy rows created before the backend column.
      const selfReporting =
        s.backend === "claude_sdk" || s.backend === "claude_sdk_stream"
          ? true
          : s.backend === "claude_cli_console" || s.backend === "codex_cli"
            ? false
            : s.mode === "deliverable" || s.mode === "coordinated";
      if (selfReporting) {
        this.store.sessions.setStatus(s.id, "failed");
        this.store.audit.append({
          type: "status_change",
          source: "dispatcher",
          sessionId: s.id,
          payload: { status: "failed", reason: "runner vanished before completion" },
        });
        this.failClosePendingApprovals(s.id, "session vanished");
      } else {
        this.store.sessions.setStatus(s.id, "done");
        this.store.audit.append({
          type: "status_change",
          source: "dispatcher",
          sessionId: s.id,
          payload: { status: "done", reason: "tmux session ended" },
        });
      }
    }
    await this.reconcileIronCurtain();
    return this.store.sessions.list(opts.active ? { active: true } : {});
  }

  attachCommand(id: string): string {
    const s = this.store.sessions.get(id);
    if (s && s.backend === "ironcurtain") {
      throw new SwitchboardError(
        "not_attachable",
        `session '${id}' is a sandboxed IronCurtain session; view it in the dashboard's Sandboxed tab`,
      );
    }
    if (!s || !s.tmuxTarget) {
      throw new SwitchboardError("unknown_session", `no attachable session '${id}'`);
    }
    const local = this.tmux.attachCommand(s.tmuxTarget);
    const { sshHost: host, transport, moshServerPath } = this.cfg.attach;
    if (!host) return local; // no remote target → bare local command (desktop)

    // Remote (phone/iPad) attach. mosh is the default: it survives sleep + network
    // roaming and types with local echo. `mosh <host> -- <tmux attach -t name>`
    // targets this exact session (works with normal login-shell access); `--server`
    // makes it self-contained when Homebrew's bin isn't on the remote PATH.
    if (transport === "mosh") {
      const server = moshServerPath ? `--server=${moshServerPath} ` : "";
      return `mosh ${server}${host} -- ${local}`;
    }
    return `ssh ${host} -t '${local}'`;
  }
}
