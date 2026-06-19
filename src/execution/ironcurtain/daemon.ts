import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname } from "node:path";

import type { SwitchboardConfig } from "../../config/schema.js";
import { SwitchboardError } from "../../core/errors.js";
import type { Logger } from "../../core/logger.js";
import { expandHome } from "../../core/paths.js";
import { IronCurtainClient } from "./client.js";

type IcConfig = SwitchboardConfig["ironcurtain"];

/**
 * Node major versions whose IronCurtain native modules (isolated-vm) load. Under
 * node 26 the V8 sandbox SILENTLY disables — so launching IronCurtain there is a
 * security-critical failure, not a warning. We refuse to SPAWN on an unsupported
 * interpreter (verifyNode), and when ADOPTING an already-running daemon we refuse
 * if its reported status proves an unsupported node / disabled sandbox
 * (assessAdoptedSandbox) — warning only when the daemon exposes no such signal.
 */
const SUPPORTED_NODE_MAJOR: ReadonlySet<number> = new Set([22, 23, 24]);

/**
 * Assess an adopted daemon's `status` payload before trusting it. IronCurtain's
 * status shape isn't a fixed contract, so we read it defensively: a recognizable
 * unsupported node major, or an explicitly-disabled sandbox, is a hard refuse.
 * When the payload carries no such signal we cannot PROVE safety — `verified:false`
 * tells the caller to adopt-but-warn (the spawn path is the only place we fully
 * control the interpreter).
 */
export function assessAdoptedSandbox(
  payload: unknown,
  supported: ReadonlySet<number>,
): { ok: true; verified: boolean } | { ok: false; reason: string } {
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const runtime = p.runtime && typeof p.runtime === "object" ? (p.runtime as Record<string, unknown>) : undefined;
  const verRaw = p.nodeVersion ?? p.node ?? runtime?.node ?? runtime?.nodeVersion;
  const major =
    typeof verRaw === "string"
      ? Number.parseInt(verRaw.replace(/^v/, "").split(".")[0] ?? "", 10)
      : typeof verRaw === "number"
        ? verRaw
        : NaN;
  if (Number.isFinite(major) && !supported.has(major)) {
    return {
      ok: false,
      reason: `it is running on node ${major}; under node 26 IronCurtain's V8 sandbox silently disables. Restart it under node 22-24.`,
    };
  }
  const sb = p.sandbox ?? p.sandboxActive ?? p.v8Sandbox;
  const sbDisabled =
    sb === false ||
    sb === "disabled" ||
    (sb !== null && typeof sb === "object" && (sb as Record<string, unknown>).active === false);
  if (sbDisabled) {
    return { ok: false, reason: "it reports an inactive sandbox." };
  }
  return { ok: true, verified: Number.isFinite(major) || sb !== undefined };
}

const SPAWN_READY_TIMEOUT_MS = 30_000;

/**
 * Owns the single shared IronCurtain daemon + its connected client. Constructed
 * only when `cfg.ironcurtain.enabled`, daemon-owned like the DashboardServer.
 *
 * `ensure()` is adopt-or-spawn: adopt a daemon that is already running (web-ui.json
 * present + a live `status`), else spawn one under the configured node@24
 * interpreter (verifying its major version first). `stop()` only SIGTERMs a daemon
 * WE spawned — never an adopted one (it may serve other clients).
 */
export class IronCurtainDaemon {
  private clientInstance: IronCurtainClient | undefined;
  private spawnedPid: number | undefined;
  private adopted = false;
  private starting: Promise<IronCurtainClient> | undefined;

  constructor(
    private readonly cfg: IcConfig,
    private readonly log: Logger,
  ) {}

  /** The connected client, or undefined until `ensure()` has succeeded. */
  get client(): IronCurtainClient | undefined {
    return this.clientInstance;
  }

  /** Idempotent: returns the connected client, adopting or spawning as needed. */
  ensure(): Promise<IronCurtainClient> {
    if (this.clientInstance) return Promise.resolve(this.clientInstance);
    if (this.starting) return this.starting;
    this.starting = this.start().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  /**
   * Connect to an ALREADY-RUNNING daemon without spawning one. Returns the client
   * if a daemon is discoverable and live, else undefined. Used by reconcile, which
   * must never spawn heavy Docker infrastructure just to check liveness.
   */
  async adopt(): Promise<IronCurtainClient | undefined> {
    if (this.clientInstance) return this.clientInstance;
    const endpoint = IronCurtainClient.discover(this.cfg);
    if (!endpoint) return undefined;
    const c = new IronCurtainClient(endpoint, this.log);
    try {
      await c.connect();
      const rep = await c.statusReport();
      if (rep.ok) {
        this.assertAdoptedSafe(rep.payload, endpoint.host, endpoint.port);
        this.adopted = true;
        this.wireClose(c);
        this.clientInstance = c;
        this.log.info("ironcurtain daemon adopted (reconcile)", { host: endpoint.host, port: endpoint.port });
        return c;
      }
    } catch {
      /* fall through to cleanup */
    }
    await c.close().catch(() => {
      /* ignore */
    });
    return undefined;
  }

  private async start(): Promise<IronCurtainClient> {
    // 1. Adopt a daemon that is already running (e.g. across a Switchboard restart).
    const existing = IronCurtainClient.discover(this.cfg);
    if (existing) {
      const c = new IronCurtainClient(existing, this.log);
      try {
        await c.connect();
        const rep = await c.statusReport();
        if (rep.ok) {
          this.assertAdoptedSafe(rep.payload, existing.host, existing.port);
          this.adopted = true;
          this.wireClose(c);
          this.clientInstance = c;
          this.log.info("ironcurtain daemon adopted", { host: existing.host, port: existing.port });
          return c;
        }
      } catch (err) {
        this.log.warn("ironcurtain adopt rejected; will spawn", { err: String(err) });
      }
      await c.close().catch(() => {
        /* ignore */
      });
    }

    // 2. Spawn our own under the configured (node@24) interpreter.
    this.verifyNode();
    await this.spawnDaemon();
    const endpoint = IronCurtainClient.discover(this.cfg);
    if (!endpoint) {
      throw new SwitchboardError("ironcurtain_start", "ironcurtain daemon did not publish web-ui.json");
    }
    const c = new IronCurtainClient(endpoint, this.log);
    await c.connect();
    this.wireClose(c);
    this.clientInstance = c;
    this.log.info("ironcurtain daemon spawned", { pid: this.spawnedPid, port: endpoint.port });
    return c;
  }

  /**
   * Refuse to adopt a daemon whose status PROVES an unsupported node / disabled
   * sandbox; warn (but adopt) when it exposes no verifiable signal. Throwing here
   * makes the start() adopt branch fall through to a fresh, node-verified spawn.
   */
  private assertAdoptedSafe(payload: unknown, host: string, port: number): void {
    const a = assessAdoptedSandbox(payload, SUPPORTED_NODE_MAJOR);
    if (!a.ok) {
      throw new SwitchboardError("ironcurtain_adopt_unsafe", `refusing to adopt the IronCurtain daemon: ${a.reason}`);
    }
    if (!a.verified) {
      this.log.warn(
        "adopting an IronCurtain daemon without a verifiable node/sandbox signal — ensure it was started under node 22-24 (node 26 silently disables the V8 sandbox)",
        { host, port },
      );
    }
  }

  /** Fail loud if the configured interpreter is not a sandbox-capable node major. */
  private verifyNode(): void {
    let out: string;
    try {
      out = execFileSync(this.cfg.nodePath, ["--version"], { encoding: "utf-8" }).trim();
    } catch (err) {
      throw new SwitchboardError(
        "ironcurtain_node",
        `cannot run ironcurtain nodePath ${this.cfg.nodePath}: ${String(err)}`,
      );
    }
    const major = Number.parseInt((out.replace(/^v/, "").split(".")[0] ?? "").trim(), 10);
    if (!SUPPORTED_NODE_MAJOR.has(major)) {
      throw new SwitchboardError(
        "ironcurtain_node",
        `ironcurtain nodePath ${this.cfg.nodePath} is node ${out} (major ${major}); IronCurtain ` +
          `requires node 22-24 — under node 26 its V8 sandbox SILENTLY disables. Point ` +
          `cfg.ironcurtain.nodePath at a node@24 binary.`,
      );
    }
    this.log.info("ironcurtain node verified", { nodePath: this.cfg.nodePath, version: out });
  }

  private spawnDaemon(): Promise<void> {
    const args = [
      this.cfg.binPath,
      "daemon",
      "--no-signal",
      "--web-ui",
      "--web-port",
      String(this.cfg.webPort),
    ];
    // Pin the ENTIRE IronCurtain process subtree to the configured node@24, not just
    // the daemon. IronCurtain launches its host-side MCP servers (memory, filesystem,
    // git) via a bare `node` resolved from PATH and inherits our env — so without
    // node@24's bin dir FIRST on PATH they fall back to the default node (26), whose
    // ABI mismatches IronCurtain's node@24-built native modules (e.g. better-sqlite3
    // in memory-mcp-server → a NODE_MODULE_VERSION load failure that silently drops
    // the memory server). node@24 stays scoped to this subtree; Switchboard itself
    // keeps running on node 26.
    const nodeBinDir = dirname(this.cfg.nodePath);
    const env = { ...process.env, PATH: `${nodeBinDir}${delimiter}${process.env.PATH ?? ""}` };
    const child = spawn(this.cfg.nodePath, args, { detached: true, stdio: "ignore", env });
    child.unref();
    this.spawnedPid = child.pid;
    const stateFile = expandHome(this.cfg.stateFile);
    const startedAt = Date.now();
    return new Promise<void>((resolve, reject) => {
      const tick = (): void => {
        if (existsSync(stateFile) && IronCurtainClient.discover(this.cfg)) {
          resolve();
          return;
        }
        if (Date.now() - startedAt > SPAWN_READY_TIMEOUT_MS) {
          reject(
            new SwitchboardError(
              "ironcurtain_start",
              `ironcurtain daemon web-ui.json not found after ${SPAWN_READY_TIMEOUT_MS}ms`,
            ),
          );
          return;
        }
        setTimeout(tick, 300);
      };
      setTimeout(tick, 300);
    });
  }

  private wireClose(c: IronCurtainClient): void {
    c.onClose((reason) => {
      this.log.warn("ironcurtain daemon connection lost", { reason });
      // Drop the dead client so the next ensure() re-adopts/re-spawns.
      if (this.clientInstance === c) this.clientInstance = undefined;
    });
  }

  /** True if the daemon is reachable right now. */
  async health(): Promise<boolean> {
    const c = this.clientInstance;
    if (!c) return false;
    try {
      return await c.status();
    } catch {
      return false;
    }
  }

  /** Stop the client; SIGTERM the daemon only if WE spawned it (never an adopted one). */
  async stop(): Promise<void> {
    const c = this.clientInstance;
    this.clientInstance = undefined;
    if (c) {
      await c.close().catch(() => {
        /* ignore */
      });
    }
    if (!this.adopted && this.spawnedPid !== undefined) {
      try {
        process.kill(this.spawnedPid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
  }
}
