/**
 * Dispatcher daemon entry point (§5.1). A long-lived process kept alive by
 * launchd. Boots the runtime, runs a heartbeat that reconciles session state,
 * and — when Signal is enabled — activates the control plane: the allowlisted
 * command channel, the dispatcher, and the approval notifier.
 *
 * It is deliberately the ONLY long-lived privileged component, and a narrow one
 * (Invariant 3): it spawns and routes, it does not itself perform unattended
 * destructive or broad-scope actions.
 */
import { loadConfig } from "../config/index.js";
import { createLogger } from "../core/logger.js";
import { checkNativeModule } from "../core/native-check.js";
import { resolveBinary } from "../core/deps.js";
import { createRuntime } from "../runtime.js";
import { SignalCliTransport, SignalControlPlane } from "../control/signal.js";
import { ApprovalNotifier } from "../control/approval-notifier.js";
import { OutboundNotifier } from "../control/outbound-notifier.js";
import { EscalationBridge } from "../control/escalation-bridge.js";
import { NullIronCurtainBridge, type IronCurtainBridge } from "../control/ironcurtain-bridge.js";
import { DashboardServer } from "../control/dashboard.js";
import { tailscaleServe, tailscaleServeOff } from "../control/tailscale.js";
import { Coordinator } from "../coordination/coordinator.js";
import { LearningService } from "../learning/service.js";
import { LearnedRulesStore } from "../learning/rules.js";
import { RetentionService } from "./retention.js";
import { Dispatcher } from "./dispatcher.js";

const RECONCILE_INTERVAL_MS = 15_000;
const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily

export async function startDaemon(): Promise<void> {
  const log = createLogger().child({ component: "daemon" });
  // Fail fast with a clear rebuild remedy if the native DB module's ABI doesn't match
  // this Node (e.g. after a `brew upgrade node`), instead of crash-looping under launchd
  // with a raw NODE_MODULE_VERSION error in daemon.err.log.
  checkNativeModule();
  const cfg = loadConfig();
  const rt = createRuntime(cfg, log);

  log.info("switchboard daemon starting", {
    home: cfg.home,
    dbPath: cfg.dbPath,
    schema: rt.store.schemaVersion(),
    signal: cfg.signal.enabled,
    dashboard: cfg.dashboard.enabled,
  });
  rt.store.audit.append({
    type: "status_change",
    source: "dispatcher",
    payload: { event: "daemon_start", pid: process.pid },
  });

  // Control plane (Signal) — only when configured with a registered account.
  let signal: SignalControlPlane | undefined;
  let notifier: ApprovalNotifier | undefined;
  let outbound: OutboundNotifier | undefined;
  let learning: LearningService | undefined;
  if (cfg.signal.enabled && cfg.signal.account) {
    const transport = new SignalCliTransport(
      cfg.signal.account,
      resolveBinary("signal-cli", cfg.signal.cliPath) ?? "signal-cli",
      log,
    );
    signal = new SignalControlPlane(
      transport,
      { account: cfg.signal.account, allowlist: cfg.signal.allowlist },
      rt.store,
      log,
    );
    notifier = new ApprovalNotifier(rt.store, signal, log);
    outbound = new OutboundNotifier(rt.store, signal, log);
    const coordinator = new Coordinator(rt.store, cfg, log);
    learning = new LearningService(rt.store, new LearnedRulesStore(cfg.stateDir));
    const dispatcher = new Dispatcher({ sessions: rt.sessions, signal, notifier, cfg, log, store: rt.store, coordinator, learning });
    notifier.start();
    outbound.start();
    await signal.start((m) => dispatcher.handle(m));
    log.info("signal control plane active", {
      account: cfg.signal.account,
      allowlisted: cfg.signal.allowlist.length,
    });
  } else {
    log.info("signal disabled — set signal.enabled + signal.account to activate the remote control plane");
  }

  // Escalation bridge (§2.B) — maps IronCurtain sandbox tool escalations into the
  // normal approvals→Signal path and relays the operator decision back. Runs even
  // without Signal (the dashboard's Sandboxed tab can decide), gated only on the
  // backend being enabled. Non-fatal: a bridge failure must not take the daemon down.
  let ironcurtainBridge: EscalationBridge | undefined;
  let bridge: IronCurtainBridge = new NullIronCurtainBridge();
  if (cfg.ironcurtain.enabled && rt.ironcurtain) {
    try {
      ironcurtainBridge = new EscalationBridge(rt.store, rt.ironcurtain, log);
      ironcurtainBridge.start();
      bridge = ironcurtainBridge;
      log.info("ironcurtain escalation bridge active");
    } catch (err) {
      log.error("ironcurtain escalation bridge failed to start — continuing without it", { err: String(err) });
      ironcurtainBridge = undefined;
    }
  }

  // Dashboard (§5.3) — localhost; exposed on the tailnet only if configured. A
  // dashboard failure (e.g. port in use) is non-fatal: the Signal control plane
  // is the critical surface and must keep running.
  let dashboard: DashboardServer | undefined;
  let tailscaleServed: { bin: string; port: number } | undefined;
  if (cfg.dashboard.enabled) {
    try {
      dashboard = new DashboardServer({ store: rt.store, sessions: rt.sessions, tmux: rt.tmux, cfg, log, bridge });
      const { port } = await dashboard.start();
      if (cfg.tailscale.serve) {
        const ts = resolveBinary("tailscale", cfg.tailscale.binPath);
        if (ts) {
          await tailscaleServe(ts, port, log);
          tailscaleServed = { bin: ts, port }; // remember so shutdown can tear the mapping down
        } else log.warn("tailscale.serve is set but the tailscale binary was not found");
      }
    } catch (err) {
      log.error("dashboard failed to start — continuing without it", { err: String(err) });
      dashboard = undefined;
    }
  }

  // Retention: age out terminal sessions older than cfg.retention.sessionDays
  // (preserving the append-only audit_log). Sweep once at startup, then daily.
  // A no-op when sessionDays is 0. Never fatal.
  const retention = new RetentionService(
    rt.store,
    { sessionDays: cfg.retention.sessionDays, stateDir: cfg.stateDir },
    log,
  );
  const runRetention = (): void => {
    try {
      retention.sweep();
    } catch (e) {
      log.warn("retention sweep failed", { err: String(e) });
    }
  };
  runRetention();
  const retentionTimer = setInterval(runRetention, RETENTION_INTERVAL_MS);

  // Heartbeat: reconciles registry ↔ tmux, surfaces new auto-allow suggestions
  // over Signal (once each), and keeps the event loop resident.
  const suggested = new Set<string>();
  const heartbeat = setInterval(() => {
    rt.sessions.list().catch((e) => log.warn("reconcile failed", { err: String(e) }));
    if (signal && learning) {
      try {
        for (const c of learning.candidates()) {
          if (suggested.has(c.id)) continue;
          suggested.add(c.id);
          void signal.notify(`💡 suggestion: ${c.description}\nreply 'promote ${c.id}' to auto-allow, or ignore.`);
        }
      } catch (e) {
        log.warn("suggestion check failed", { err: String(e) });
      }
    }
  }, RECONCILE_INTERVAL_MS);

  let shuttingDown = false;
  const shutdown = async (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("switchboard daemon stopping", { signal: sig });
    clearInterval(heartbeat);
    clearInterval(retentionTimer);
    notifier?.stop();
    outbound?.stop();
    ironcurtainBridge?.stop();
    await signal?.stop();
    await dashboard?.stop();
    await rt.ironcurtain?.stop();
    if (tailscaleServed) {
      await tailscaleServeOff(tailscaleServed.bin, tailscaleServed.port).catch((e) =>
        log.warn("tailscale serve off failed", { err: String(e) }),
      );
    }
    rt.store.audit.append({
      type: "status_change",
      source: "dispatcher",
      payload: { event: "daemon_stop", signal: sig },
    });
    rt.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
