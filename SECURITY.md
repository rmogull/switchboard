# Security

Switchboard runs AI coding agents with broad local access and dispatches them remotely,
so its security model is the product, not an afterthought. This document describes the
threat model, the controls, and how to report issues.

## Threat model

Switchboard assumes:

- **Worker output and fetched content are hostile.** A diff, a critique, a web page, a
  repo's contents, or a tool result may contain prompt-injection payloads. None of it is
  ever re-interpreted as a command or allowed to redirect control flow (Invariants 2, 4).
- **There are two operator surfaces, both authenticated.** Commands come from a
  hard-allowlisted Signal sender; everything else on that channel is logged and dropped. The
  **dashboard is a second operator surface** — a full control plane (it can kill sessions,
  decide approvals, spawn sandboxed sessions) gated by a bearer token (see *The dashboard is
  a control plane* below). Both are trusted inputs; fetched/worker content is not.
- **Agents will try to do more than asked.** Consequential actions are gated; in
  coordinated tasks, landing authority is structural — the executor enforces it, not the
  agent's good behavior.

## The seven invariants

1. **Official binaries only** — never extract, store, or forward subscription OAuth tokens.
2. **Vetted input only** — act only on an allowlisted Signal sender; content is data, never instruction.
3. **Privileged but narrow coordinator** — the dispatcher routes; it performs no unattended destructive/broad-scope actions.
4. **Deterministic control flow over tainted output** — the model plans, code executes.
5. **Curated memory writes** — children propose, the operator/dispatcher promotes, with provenance.
6. **Append-only audit log** — immutable, enforced by SQLite triggers; never read back as instruction.
7. **Gated consequence + structural authority** — explicit approval for consequence; decider-only landing.

## Key controls

- **Permission policy (fail-closed).** Every tool-use is classified (`policy.ts`); anything
  not confidently safe resolves to `ask`. The Bash classifier hardens against
  command-substitution, env-prefix, and compound-command bypasses; path containment is
  symlink-resolved and prefix-safe; the egress allowlist is suffix-spoof-safe.
- **SDK isolation.** Gated Claude sessions run with `settingSources: []` so the operator's
  ambient `~/.claude` allow-list cannot bypass the policy. This is enforced through one
  helper (`buildGatedSdkOptions`) and guarded by a test.
- **Async approvals, fail closed.** An `ask` blocks the tool on an out-of-band decision
  (Signal `y/n` or the dashboard); a timeout denies.
- **Append-only audit.** `UPDATE`/`DELETE` on the audit log are rejected by SQLite triggers.
- **No silent policy drift.** Auto-allow rules are created only by explicit operator
  confirmation of a suggestion, and every promotion is audited with its source approvals.

The permission code was reviewed by a multi-agent adversarial pass; findings (including a
symlink write-containment escape) were fixed with regression tests.

## The dashboard is a control plane

The dashboard is not a read-only viewer — it can kill sessions, decide approvals, and spawn
sandboxed sessions. It is protected by three layers:

- **Bearer token.** Every `/api` route requires a token (`dashboard.token`); `init`
  generates one. You open the dashboard as `http://<host>:<port>/?token=<token>`; a request
  without the matching token gets `401`.
- **Localhost binding.** It binds `127.0.0.1` by default. Remote reach is via
  `tailscale serve` on your tailnet only.
- **Tailnet ACLs.** Exposure is limited to devices on your tailnet.

Hard rules:

- **It refuses to start exposed without a token.** A non-loopback `bindAddress` *or*
  `tailscale.serve: true` with no `dashboard.token` set is a startup error, not a warning.
- **Any tailnet device that has the token is a full operator** — it can kill sessions,
  decide approvals, and spawn sandboxed sessions. Treat the token like a root credential.
- **`tailscale funnel` (public internet exposure) is forbidden.** Use `tailscale serve`
  (tailnet-only) and never funnel.

## Telemetry & logs

- **No telemetry.** Switchboard phones home to nothing; it makes no analytics or
  usage-reporting calls.
- **Daemon logs may contain sensitive fragments.** Logs under `<stateDir>/logs/` (e.g.
  `daemon.out.log`, `daemon.err.log`) can include transcript fragments and Signal sender
  numbers. The `stateDir` is created mode `0700` (owner-only); keep it that way and outside
  any synced/shared folder.

## Secrets

Secrets never enter the repository. `signal-cli` registration, the dedicated number, the
operator allowlist, Tailscale state, and the `dashboard.token` all live in gitignored
config/state. `switchboard.config.json` is written mode `0600`, the `home`/`stateDir`
directories mode `0700`; only `switchboard.config.example.json` is committed.

If you used a dedicated-number provider such as **Twilio** to obtain the Signal number (see
the README's Prerequisites), any provider credentials are a setup-time prerequisite for
*acquiring* that number — Switchboard itself stores no Twilio credentials.

## Reporting a vulnerability

Please report security issues **privately** rather than opening a public issue. Email the
maintainer at **rmogull@securosis.com**. Include a description, the affected
version/commit, and a reproduction if possible. Allow time for a fix before any public
disclosure.
