import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

import type { ResolvedConfig } from "../config/index.js";
import type { Logger } from "../core/logger.js";
import type { Store } from "../state/db.js";
import type { SessionManager } from "../execution/session.js";
import type { Tmux } from "../execution/tmux.js";
import { listIronCurtainPersonas, isKnownPersona } from "../execution/ironcurtain/personas.js";
import { type IronCurtainBridge, NullIronCurtainBridge } from "./ironcurtain-bridge.js";
import { DASHBOARD_HTML } from "./dashboard-html.js";
import { SwitchboardError } from "../core/errors.js";

export interface DashboardDeps {
  store: Store;
  sessions: SessionManager;
  tmux: Tmux;
  cfg: ResolvedConfig;
  log: Logger;
  /** Read/decide surface for the Sandboxed tab; defaults to the inert Null bridge. */
  bridge?: IronCurtainBridge;
}

/**
 * The Tailscale-served control dashboard (§5.3). A deliberately thin control
 * plane — session list/log/kill/attach and the pending-approval queue — NOT a
 * terminal (the native terminal apps are the good interactive surface). Binds
 * localhost only; reachable remotely solely via `tailscale serve`, never a
 * public port (§3).
 */
export class DashboardServer {
  private server: Server | undefined;
  private readonly bridge: IronCurtainBridge;

  constructor(private readonly deps: DashboardDeps) {
    this.bridge = deps.bridge ?? new NullIronCurtainBridge();
  }

  start(): Promise<{ address: string; port: number }> {
    const { cfg } = this.deps;
    // Refuse to expose an unauthenticated control plane. When bound beyond loopback
    // (or served on the tailnet), a token is mandatory — any reachable device could
    // otherwise kill sessions, decide approvals, and spawn sandboxed sessions.
    const loopback = isLoopbackAddress(cfg.dashboard.bindAddress);
    if ((!loopback || cfg.tailscale?.serve === true) && !cfg.dashboard.token) {
      return Promise.reject(
        new SwitchboardError(
          "dashboard_insecure",
          `Refusing to start the dashboard exposed (${!loopback ? `bindAddress=${cfg.dashboard.bindAddress}` : "tailscale.serve=true"}) with no dashboard.token set. ` +
            "Any device that can reach it would be a full operator. Set dashboard.token (run `switchboard init` to generate one), " +
            "or bind 127.0.0.1 with tailscale.serve=false. NEVER expose it with `tailscale funnel`.",
        ),
      );
    }
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        this.deps.log.error("dashboard request failed", { err: String(err) });
        this.json(res, 500, { error: String(err) });
      });
    });
    return new Promise((resolve, reject) => {
      const server = this.server!;
      // EADDRINUSE etc. arrive as an 'error' event, not a callback — reject so the
      // caller can decide (the daemon treats a dashboard failure as non-fatal).
      const onError = (err: Error) => reject(err);
      server.once("error", onError);
      server.listen(cfg.dashboard.port, cfg.dashboard.bindAddress, () => {
        server.removeListener("error", onError);
        const addr = server.address();
        const port = typeof addr === "object" && addr ? addr.port : cfg.dashboard.port;
        this.deps.log.info("dashboard listening", { address: cfg.dashboard.bindAddress, port });
        resolve({ address: cfg.dashboard.bindAddress, port });
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    const s = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(s) });
    res.end(s);
  }

  private async readBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    if (chunks.length === 0) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      return {};
    }
  }

  /** True when no token is configured, or the request carries the matching bearer token. */
  private authed(req: IncomingMessage, url: URL): boolean {
    const token = this.deps.cfg.dashboard.token;
    if (!token) return true; // no token (loopback-only install) → no gate
    const auth = req.headers["authorization"];
    const bearer = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const provided = bearer || url.searchParams.get("token") || "";
    // Compare by BYTE length — a multibyte provided value can equal the token in JS
    // string length but differ in bytes, which makes timingSafeEqual throw (a 500
    // instead of a clean 401).
    const a = Buffer.from(provided);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://localhost`);
    const path = url.pathname;
    const method = req.method ?? "GET";

    // Auth gate: every /api route requires the bearer token when one is configured.
    // GET "/" (the static shell) is exempt so the page can bootstrap and read ?token=.
    if (path.startsWith("/api/") && !this.authed(req, url)) {
      return this.json(res, 401, { error: "unauthorized" });
    }

    if (method === "GET" && path === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(DASHBOARD_HTML);
      return;
    }

    if (method === "GET" && path === "/api/state") {
      // The native tab shows native sessions only; sandboxed (ironcurtain) sessions
      // and their bridged escalations live in the Sandboxed tab (filtered out here so
      // the two surfaces never double-show the same item).
      const sessions = (await this.deps.sessions.list()).filter((s) => s.backend !== "ironcurtain");
      const approvals = this.deps.store.approvals
        .listPending()
        .filter((a) => (safeParse(a.requestJson) as { source?: unknown } | null)?.source !== "ironcurtain")
        .map((a) => ({
          id: a.id,
          sessionId: a.sessionId,
          toolName: a.toolName,
          request: safeParse(a.requestJson),
          requestedAt: a.requestedAt,
        }));
      // Coordination view (§5.3): recent plans with their phase, decider, and the
      // participant sessions (registered rows) working under each.
      const coordinations = this.deps.store.coordination.recent(10).map((c) => {
        const topo = safeParse(c.topologyJson) as { participants?: Array<{ label?: string; role?: string; client?: string }>; decider?: string } | string | null;
        const planned = topo && typeof topo === "object" && Array.isArray(topo.participants) ? topo.participants : [];
        const participants = sessions
          .filter((s) => s.coordinationId === c.id)
          .map((s) => ({ id: s.id, role: s.role, client: s.client, status: s.status }));
        return {
          id: c.id,
          phase: c.phase,
          decider: c.deciderSessionId,
          planned: planned.map((p) => ({ label: p.label ?? "", role: p.role ?? "", client: p.client ?? "" })),
          participants,
          updatedAt: c.updatedAt,
        };
      });
      this.json(res, 200, {
        sessions,
        approvals,
        coordinations,
        now: Date.now(),
        // Drives the dashboard's one-tap "Open in Prompt" deep link (config-driven
        // so the favorite name isn't baked into the bundled frontend).
        attach: { promptFavorite: this.deps.cfg.attach?.promptFavorite ?? "switchboard" },
      });
      return;
    }

    // /api/sessions/:id/{log,kill,attach,transcript}
    const sm = path.match(/^\/api\/sessions\/([^/]+)\/(log|kill|attach|transcript)$/);
    if (sm) {
      const id = decodeURIComponent(sm[1]!);
      const action = sm[2]!;
      const session = this.deps.store.sessions.get(id);
      if (!session) return this.json(res, 404, { error: "no such session" });

      // Only the streaming runner writes a transcript; the one-shot deliverable/
      // coordinated runner (claude_sdk) and raw-CLI/Codex sessions show their tmux
      // pane capture instead.
      const hasTranscript = session.backend === "claude_sdk_stream";

      if (action === "transcript" && method === "GET") {
        const after = Math.max(0, Number(url.searchParams.get("after") ?? 0) || 0);
        const limit = Math.min(Number(url.searchParams.get("limit") ?? 500) || 500, 2000);
        const rows = this.deps.store.transcript.listAfter(id, after, limit);
        const cursor = rows.length ? rows[rows.length - 1]!.seq : after;
        return this.json(res, 200, { id, rows, cursor });
      }

      if (action === "log" && method === "GET") {
        if (hasTranscript) {
          const lines = Math.min(Number(url.searchParams.get("lines") ?? 300) || 300, 2000);
          const rows = this.deps.store.transcript.listRecent(id, lines);
          const log = rows.length ? rows.map(renderTranscriptLine).join("\n") : "(no transcript yet)";
          return this.json(res, 200, { id, log });
        }
        const lines = Math.min(Number(url.searchParams.get("lines") ?? 200) || 200, 5000);
        const log = session.tmuxTarget ? await this.deps.tmux.capturePane(session.tmuxTarget, lines).catch(() => "(pane unavailable)") : "(no pane)";
        return this.json(res, 200, { id, log });
      }
      if (action === "attach" && method === "GET") {
        if (session.backend === "ironcurtain") {
          return this.json(res, 409, { id, error: "sandboxed session — view it in the Sandboxed tab (no tmux pane to attach)" });
        }
        return this.json(res, 200, { id, command: this.deps.sessions.attachCommand(id) });
      }
      if (action === "kill" && method === "POST") {
        await this.deps.sessions.kill(id);
        return this.json(res, 200, { id, status: "killed" });
      }
    }

    // /api/approvals/:id/decide  { decision: "approved" | "denied", scope?: "once" | "session" }
    const am = path.match(/^\/api\/approvals\/([^/]+)\/decide$/);
    if (am && method === "POST") {
      const id = decodeURIComponent(am[1]!);
      const body = (await this.readBody(req)) as { decision?: string; scope?: string };
      if (body.decision !== "approved" && body.decision !== "denied") {
        return this.json(res, 400, { error: "decision must be approved|denied" });
      }
      // `session` scope (approve this tool for the rest of the session) only applies
      // to an approval; a deny is always single. Default `once`.
      const scope = body.decision === "approved" && body.scope === "session" ? "session" : "once";
      // Capture the originating session BEFORE deciding, so the audit record
      // correlates the decision to its session (Invariant 6 provenance).
      const approval = this.deps.store.approvals.get(id);
      const ok = this.deps.store.approvals.decide(id, body.decision, "dashboard", scope);
      if (ok) {
        this.deps.store.audit.append({
          type: "approval_decision",
          sessionId: approval?.sessionId ?? null,
          source: "dashboard",
          payload: { id, status: body.decision, via: "dashboard", scope },
        });
      }
      return this.json(res, ok ? 200 : 409, { id, decided: ok });
    }

    // /api/sessions/:id/remote-control — re-issue the `/remote-control` slash command
    // into a live NATIVE pane. This is the operator's host-side lever to (re)enable
    // Remote Control and re-surface its reconnect URL/QR — the same command an operator types
    // by hand, just triggerable from the dashboard (e.g. when the phone client goes
    // stale while the host session is still alive). Confined to native console panes —
    // NEVER a gated SDK/streaming/codex pane — and every inject is audited.
    const rc = path.match(/^\/api\/sessions\/([^/]+)\/remote-control$/);
    if (rc && method === "POST") {
      const id = decodeURIComponent(rc[1]!);
      const session = this.deps.store.sessions.get(id);
      if (!session) return this.json(res, 404, { error: "no such session" });
      if (session.backend !== "claude_cli_console") {
        return this.json(res, 409, { error: "remote-control is only for native console sessions" });
      }
      if (session.status === "done" || session.status === "failed" || session.status === "killed") {
        return this.json(res, 409, { error: "session is not live" });
      }
      if (!session.tmuxTarget) return this.json(res, 409, { error: "session has no pane" });
      // Audit the operator action BEFORE the side effect, so the inject is recorded even
      // if the tmux call throws or only partially lands (every consequential action audited).
      this.deps.store.audit.append({
        type: "status_change",
        sessionId: id,
        source: "dashboard",
        payload: { event: "remote_control_reconnect", command: "/remote-control" },
      });
      await this.deps.tmux.sendKeys(session.tmuxTarget, "/remote-control");
      return this.json(res, 200, { id, sent: "/remote-control" });
    }

    // /api/sessions/:id/convert  { target?: "local" | "remote_control" }
    // Convert a gated streaming session into a native full-CLI session in place
    // (continue anywhere). A DELIBERATE downgrade to CLI-handled permissions; the
    // posture change + fail-closed approvals are audited in convertToNative.
    const cv = path.match(/^\/api\/sessions\/([^/]+)\/convert$/);
    if (cv && method === "POST") {
      const id = decodeURIComponent(cv[1]!);
      const body = (await this.readBody(req)) as { target?: string };
      const remoteControl = body.target === "remote_control";
      try {
        const s = await this.deps.sessions.convertToNative(id, { remoteControl });
        return this.json(res, 200, { id, backend: s.backend, remoteControl });
      } catch (e) {
        return this.json(res, 409, { id, error: String(e) });
      }
    }

    // ---- IronCurtain (Sandboxed tab) -------------------------------------
    // Mirrors /api/state but reads the bridge's view: sandboxed sessions + the
    // pending escalations bridged from the daemon. `enabled` drives tab visibility.
    if (method === "GET" && path === "/api/ironcurtain/state") {
      return this.json(res, 200, {
        enabled: this.bridge.enabled(),
        sessions: this.bridge.listSessions(),
        escalations: this.bridge.listEscalations(),
        personas: listIronCurtainPersonas(this.deps.cfg.ironcurtain.personasDir),
        now: Date.now(),
      });
    }

    // GET /api/ironcurtain/sessions/:id/digest — read-only status + escalation
    // history (no tmux; sandboxed sessions have no pane).
    const icd = path.match(/^\/api\/ironcurtain\/sessions\/([^/]+)\/digest$/);
    if (icd && method === "GET") {
      const id = decodeURIComponent(icd[1]!);
      const digest = this.bridge.sessionDigest(id);
      if (!digest) return this.json(res, 404, { error: "no such sandboxed session" });
      return this.json(res, 200, digest);
    }

    // POST /api/ironcurtain/escalations/:id/decide { decision: "approved"|"denied" }
    // The same conditional decide as a Signal reply; the bridge relays it back to
    // IronCurtain on its next poll. Resolve-exactly-once, so dashboard + Signal can't
    // double-decide. The audit row records the dashboard provenance.
    const ice = path.match(/^\/api\/ironcurtain\/escalations\/([^/]+)\/decide$/);
    if (ice && method === "POST") {
      const id = decodeURIComponent(ice[1]!);
      const body = (await this.readBody(req)) as { decision?: string };
      if (body.decision !== "approved" && body.decision !== "denied") {
        return this.json(res, 400, { error: "decision must be approved|denied" });
      }
      // Capture the originating session id BEFORE deciding (provenance), reading the
      // approval row directly — the bridge attributes the row to the sandbox session.
      const approval = this.deps.store.approvals.get(id);
      const r = this.bridge.decideEscalation(id, body.decision);
      if (r.ok) {
        this.deps.store.audit.append({
          type: "approval_decision",
          // audit_log has NO session FK, so the (possibly synthetic) sandbox id is safe.
          sessionId: approval?.sessionId ?? null,
          source: "dashboard",
          payload: { id, status: body.decision, via: "dashboard:ironcurtain" },
        });
      }
      return this.json(res, r.ok ? 200 : 409, { id, decided: r.ok, error: r.error });
    }

    // POST /api/ironcurtain/sessions { persona?, task? } — spawn a sandboxed session
    // (the dashboard trigger surface). Persona is validated against the installed,
    // pre-compiled allowlist so an arbitrary name can never reach sessions.create.
    if (method === "POST" && path === "/api/ironcurtain/sessions") {
      if (!this.bridge.enabled()) return this.json(res, 409, { error: "ironcurtain backend is not enabled" });
      const body = (await this.readBody(req)) as { persona?: string; task?: string };
      const persona = typeof body.persona === "string" && body.persona.trim() ? body.persona.trim() : undefined;
      if (persona && !isKnownPersona(this.deps.cfg.ironcurtain.personasDir, persona)) {
        return this.json(res, 400, { error: `unknown persona '${persona}'` });
      }
      const task = typeof body.task === "string" && body.task.trim() ? body.task.trim() : undefined;
      try {
        const s = await this.deps.sessions.spawn({
          client: "claude",
          mode: "deliverable",
          control: "ironcurtain",
          ...(persona ? { persona } : {}),
          ...(task ? { task } : {}),
        });
        return this.json(res, 200, { id: s.id, status: s.status });
      } catch (e) {
        return this.json(res, 409, { error: String(e) });
      }
    }

    this.json(res, 404, { error: "not found" });
  }
}

function isLoopbackAddress(addr: string): boolean {
  if (addr === "localhost") return true;
  // Only a PARSED loopback IP is safe. A hostname (isIP === 0) such as "127.evil.com"
  // is not loopback — server.listen() accepts hostnames and DNS could resolve it
  // off-box, so it must require a token.
  const kind = isIP(addr);
  if (kind === 4) return addr.startsWith("127.");
  if (kind === 6) {
    const a = addr.toLowerCase();
    return a === "::1" || a.startsWith("::ffff:127.");
  }
  return false;
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

const TRANSCRIPT_LABEL: Record<string, string> = {
  user: "you",
  assistant: "claude",
  result: "result",
  status: "·",
};

/** Render one transcript row as a plain-text line for the dashboard log view.
 * The frontend inserts this via textContent (never HTML), so model output here is
 * display DATA and is never interpreted (Invariant 4). */
function renderTranscriptLine(r: { kind: string; source: string; text: string }): string {
  const who = TRANSCRIPT_LABEL[r.kind] ?? r.kind;
  const via = r.kind === "user" && r.source !== "session" ? ` (${r.source})` : "";
  return `[${who}${via}] ${r.text}`;
}
