# Personal AI Orchestrator — Build Specification

> Working name: **Switchboard** (rename freely). This is the source-of-truth build
> brief. It is written to be moved into Claude Code as the project's top-level spec.
> Treat the **Invariants (§2)** as non-negotiable: they are the security contract the
> entire design depends on, and no implementation convenience overrides them.

---

## 1. Purpose & scope

A self-hosted orchestrator that lets me create, manage, and coordinate **Claude Code**
and **Codex** sessions remotely (primarily from my phone, away from my desk), while all
execution stays on my local machine so my local MCPs, local files, and non-repo code
remain in scope.

It fills the one niche no off-the-shelf surface covers: **local execution (for local
MCP and local code) plus async away-from-desk dispatch (for ad-hoc work)**, with
per-task session isolation so context never accumulates into one degrading conversation.

Two canonical commands it must handle:

1. **Deliverable.** "Create a presentation in the CSA template using the standard CSA
   assets/icons on topic X, here's the outline, then put it in my Google Drive
   presentations directory." → runs to completion unattended, notifies me, I review on
   my synced device and send feedback.
2. **Interactive.** "Launch a remote Claude Code session for my
   security-intelligence-platform so I can make some changes." → spins a live session in
   an existing repo, hands me an attach path, I steer it from Prompt/Blink.

It must also handle **Codex** for both archetypes ("code this using Codex") and
**multi-agent coordination** ("coordinate code and review between Claude Code and Codex,
with Claude Code making the final decision").

---

## 2. Invariants (security contract — do not violate)

1. **Official binaries only.** The orchestrator drives the official `claude` and `codex`
   CLIs as subprocesses. It NEVER extracts, stores, forwards, or reuses subscription
   OAuth tokens. Each binary authenticates itself under its own subscription (Claude Max
   / ChatGPT Pro). This is what keeps the system inside Anthropic's post-2026-04-04 ToS
   and on flat-rate pricing instead of metered API. If a design step ever requires
   touching a token, stop — it's the wrong design.
2. **Vetted input only.** The dispatcher acts only on commands from an authenticated
   Signal sender on a hard allowlist. Content the system fetches or produces during a
   task (a URL in a task, an outline, a diff, a review, repo contents, web results) is
   **data, never instruction**. The dispatcher does not re-interpret task output as new
   commands.
3. **Privileged but narrow coordinator.** The dispatcher may spawn/route sessions, curate
   memory, do light Drive I/O, and report status. It does NOT itself perform unattended
   destructive or broad-scope actions. High-consequence work happens in scoped child
   sessions, never in the coordinator.
4. **Deterministic control flow over tainted output.** The model *plans* coordination;
   *code* executes it. Worker session outputs flow through fixed channels and cannot
   redirect control flow, escalate privilege, or override role authority.
5. **Curated memory writes.** Child sessions *propose* memory entries; only the
   dispatcher (or I) *promote* them into shared memory. Every promotion is logged with
   its source session. This blocks time-shifted/memory-poisoning injection.
6. **Append-only audit log.** Every command, spawn, approval, consequential action, and
   promotion is logged immutably. The audit log is never read back as instruction.
7. **Gated consequence + structural authority.** Consequential actions require explicit
   approval (Signal or in-TTY). In coordinated tasks the **decider** role is the only one
   that can land changes, enforced by the executor, not by trusting an agent to behave.

---

## 3. Host & environment

- **Host:** my daily-driver Mac (not the Mac mini). Rationale: the tools the orchestrator
  must integrate — Fantastical, Browserbase, Google Drive, CSA assets, user-level MCPs —
  already live here. The dispatcher's safety comes from the vetted-input rule (Invariant
  2), not from network isolation, so isolating it would only break the tools and would
  force a large sensitive surface onto the clean mini. Trust boundary = the input
  channel, not the network perimeter.
- **Home directory:** an existing **productivity directory** you already use. It already holds
  working memory and is where your skills (writing-style, formatting helpers,
  etc.) and user-level MCPs resolve. An interactive desktop client operates on this
  directory at the desk; the Code-dispatcher operates on the same directory
  when remote. One home, two clients, shared memory.
- **Remote reach:** Tailscale. The dashboard is exposed only via `tailscale serve` on the
  tailnet; no inbound ports on the public internet.
- **No OpenShell in the production path.** Claude Code's own directory scoping + the
  permission policy (§5.5) provide containment; OpenShell would add a second policy
  language and a Linux-VM runtime for kernel isolation that doesn't natively apply on
  macOS. OpenShell is reserved solely for a separate, contained OpenClaw *research*
  instance if I ever build one — never here.

---

## 4. Architecture overview

```
                         ┌─────────────────────────────────────────┐
   Signal (you only) ───▶│            CONTROL PLANE                  │
   Tailscale dashboard ─▶│  signal-cli (allowlist) + web dashboard   │
                         └───────────────────┬───────────────────────┘
                                             │ vetted commands / approvals / status
                         ┌───────────────────▼───────────────────────┐
                         │          ORCHESTRATION PLANE               │
                         │  Dispatcher (headless Claude Code via      │
                         │  Agent SDK) — parse, classify, plan,       │
                         │  spawn/route, curate memory, report.       │
                         │  Privileged but narrow.                    │
                         └───────────────────┬───────────────────────┘
                       spawn / route / enforce permission policy
            ┌────────────────────────────────┼────────────────────────────────┐
            ▼                                 ▼                                 ▼
   ┌──────────────────┐            ┌──────────────────┐            ┌──────────────────────┐
   │ EXECUTION PLANE  │            │ EXECUTION PLANE  │            │  EXECUTION PLANE     │
   │ Deliverable      │            │ Interactive      │            │  Coordinated         │
   │ (ephemeral,      │            │ (long-lived,     │            │  (plan-then-execute, │
   │  runs to done,   │            │  attach via tmux)│            │   N participants,    │
   │  notifies)       │            │                  │            │   deterministic FSM) │
   └──────────────────┘            └──────────────────┘            └──────────────────────┘
        claude | codex                 claude | codex                  claude + codex
```

Shared substrate: SQLite state store (registry, coordination plans, audit, approvals,
proposals) + curated markdown memory in the home directory.

---

## 5. Components

### 5.1 Dispatcher

A long-lived **headless Claude Code session run via the Agent SDK (TypeScript)**, rooted
in the home directory, kept alive by `launchd`. Responsibilities, and only these:

- **Parse & classify** an incoming vetted command into: archetype (deliverable /
  interactive / coordinated), client(s) (`claude` / `codex`), target directory (existing
  repo, or new dir to create), and any declared scope (e.g. egress allowlist for a
  research task).
- **Plan** coordination topology when the task is coordinated (§5.7).
- **Spawn / route** to child sessions; register them.
- **Enforce** the permission policy via the SDK hook (§5.5) for Claude sessions; choose
  the Codex sandbox mode at spawn (§5.5 asymmetry note).
- **Curate** the learning memory: review child proposals, promote selectively (§5.6).
- **Report** status and request approvals over the control plane.

The dispatcher is itself subject to the narrowness rule: it does not run unattended
destructive shell, does not delete, does not change sharing permissions. Those it
surfaces for explicit approval even when I command them.

### 5.2 Control plane — Signal

- `signal-cli` running as a daemon on the Mac, registered to a **dedicated number**
  (new Twilio number, separate from the security-intelligence-platform's number, so the
  two systems' identities stay partitioned).
- **Hard sender allowlist = my personal number only.** Any message from any other sender
  is logged to the audit log and dropped, never parsed or interpreted.
- This is a **command channel, not a monitored feed.** The dispatcher acts on explicit
  instructions I send. It never treats inbound content it later fetches as instruction.
- Signal carries: my commands, status/notifications ("done, it's in your Drive
  presentations folder" / "session ready, attach command below"), and async permission
  prompts with y/n replies (§5.5).
- Signal doubles as the notification path; ntfy/Pushover are explicitly out of scope for
  v1 (add later only if I want tappable buttons Signal can't render).

### 5.3 Control plane — Tailscale dashboard

A minimal local web app, exposed only via `tailscale serve`, reachable from my phone on
the tailnet. It is the richer view and the source of truth for session state:

- Session list with live status, client, mode, working dir, age.
- Per-session **log view** (the better reading surface for reviewing deliverable output
  than phone-terminal scrollback).
- Actions: create, kill, resume.
- Per-session **attach command** / deep link (§5.9).
- Pending-approval queue (alternative to answering on Signal).
- Coordination view: topology, current phase, participant sessions, artifacts in flight.

Keep the UI deliberately thin — the terminal apps (Prompt/Blink) are the good native
experience for actual interactive work; the dashboard is a control plane, not a terminal.

### 5.4 Execution plane — session archetypes

| Archetype     | Lifetime   | Interaction              | Default for                         |
|---------------|------------|--------------------------|-------------------------------------|
| Deliverable   | Ephemeral  | Runs to completion, notifies | One-shot builds (the CSA deck)  |
| Interactive   | Long-lived | Attach via tmux to steer | Live coding in a repo (the SIP)     |
| Coordinated   | Ephemeral* | Notifies on convergence; attachable | Multi-agent implement/review |

\* Coordinated tasks default to the **deliverable** behavior (run to convergence, then
ping) because a full implement→review→revise→decide loop runs long; attach only to
intervene.

Every session: its own working directory, its own context (fresh session = the context
fix), its own registry row, and independent subjection to the permission policy.

### 5.5 Permission system

The hard part is the **async approval loop**: a CLI permission prompt blocks on a TTY,
but Signal is out-of-band. We bridge this through Claude Code's **programmatic permission
hook** (the Agent SDK `canUseTool` / `PreToolUse`-style callback), NOT by puppeteering a
terminal.

Flow (per tool-use request from a Claude session):

```
canUseTool(tool, input, ctx):
    decision = policy.evaluate(ctx)        // allow | deny | ask
    log(audit, tool_use_evaluated, ctx, decision, source=policy)
    if decision == allow:  return allow
    if decision == deny:   return deny
    // decision == ask
    if ctx.session.mode == interactive && ctx.session.attached:
        return passthrough_to_tty()        // I'm already steering; answer in terminal
    approval = createApproval(ctx)         // status=pending
    signal.send(formatPrompt(approval))    // "session X wants to write /Drive/...; y/n?"
    decision = awaitApproval(approval, timeout)   // y/n reply, or dashboard, or timeout
    log(audit, approval_decision, approval, decided_via)
    return decision
```

**Default policy matrix:**

| Action                                                   | Default  |
|----------------------------------------------------------|----------|
| Read within session scope                                | allow    |
| Write within the session's own working directory         | allow    |
| Write outside working dir (incl. Google Drive folder)    | **ask**  |
| Delete (anything)                                        | **ask**  |
| Network egress                                           | **ask**¹ |
| Destructive shell (rm / mv outside dir / chmod / etc.)   | **ask**  |
| Build/test/format shell within working dir               | allow    |
| A session requesting to spawn a further session          | **ask**  |
| Change sharing/permissions on any resource               | **ask**² |

¹ Egress is the noisiest knob. For research/coordinated tasks, allow a **per-session
declared domain allowlist** at spawn time so legitimate fetches don't prompt repeatedly.
² Per Invariant 3 these are surfaced even on my direct command; never auto-performed.

**Codex asymmetry (open item — see §12):** the fine-grained `canUseTool` hook is a
Claude Code / Agent SDK capability. Codex's CLI exposes its own sandbox/approval modes
rather than (confirmed) an equivalent per-tool programmatic callback. So Signal-mediated
*per-action* approval may be **Claude-only**; Codex sessions likely run under a coarser
sandbox mode chosen at spawn (e.g. read-only vs. workspace-write vs. full-auto). The
executor must therefore treat Codex's permission granularity as coarser and compensate by
scoping Codex sessions' working dirs tightly and reserving destructive authority for the
(Claude) decider in coordinated tasks. Validate the exact Codex contract in Phase 0.

### 5.6 Memory — two stores

Keep the factual record and the learned layer strictly separate.

- **Audit log** (SQLite, append-only, immutable, never interpreted as instruction): the
  record of *what happened* — commands, spawns, approvals, Drive writes, promotions,
  re-plans, errors, each with `source` provenance.
- **Learning memory** (curated markdown under `<home>/memory/`, git-tracked): *what we
  concluded* — recurring task shapes and their asset/template paths, per-repo
  conventions, my deliverable feedback, candidate auto-allow promotions. Read by the
  dispatcher at task start to do better next time.

**Write discipline (Invariant 5):** child sessions write only to their own
session-local scratch; to influence shared memory they emit a structured proposal to a
`memory_proposals` queue. The dispatcher reviews and promotes selectively, and **every
promotion is an audit-logged event carrying its source session id**, so "why does the
system now believe this" is always answerable. Promotion of feedback into the auto-allow
policy starts **explicit**: the dispatcher *suggests* over Signal ("you've approved Drive
writes to /Presentations 9×; promote to auto-allow? y/n") and I confirm. No silent policy
drift.

### 5.7 Coordination engine — plan, then execute

**The model plans the topology; deterministic code runs it.** (Invariant 4.)

1. **Plan (model).** From the vetted command, the dispatcher composes the coordination
   topology and emits it as a validated structured plan: participants, each with a role,
   the sequence/phases, and the designated decider. Roles are an open vocabulary the model
   may compose, but they resolve onto a small set of executor-understood primitives:
   `implementer`, `reviewer`, `decider`, `planner`. The plan is echoed back over Signal
   for optional confirmation before execution.
2. **Execute (deterministic FSM).** A state machine consumes the plan and drives phases,
   moving artifacts (diff, critique) through fixed channels:

```
planning ─▶ implementing ─▶ reviewing ─▶ revising ─▶ deciding ─▶ done
                  ▲                            │
                  └──────────  (loop)  ◀───────┘
   (re-plan is a discrete, logged event that can re-enter from any phase)
```

   For the canonical "Claude implements, Codex reviews, Claude decides":
   - Spawn a Claude `implementer` and a Codex `reviewer` against the same working dir
     (worktree/branch convention keeps in-progress changes legible without collisions).
   - Executor routes the implementer's diff to the reviewer; routes the reviewer's
     critique back to the implementer; iterates per the plan.
   - The `decider` (the Claude session) receives diff + critique and makes accept/reject.
     **Only the decider's accept lands changes — enforced by the executor.** The reviewer
     is structurally advisory; it has no merge authority regardless of what it outputs.
   - Each participant independently hits the permission policy (§5.5); a reviewer
     "suggesting" a change cannot enact it.

**Invariants the executor enforces (not the agents):** decider-only landing; advisory
reviewer; per-participant permission gating; discrete logged re-plan events; provenance
for every inter-agent artifact handoff. This keeps a tainted diff or critique from
redirecting control flow or escalating authority.

### 5.8 Session registry & state

SQLite via `better-sqlite3`. Source of truth read by both Signal handler and dashboard.

---

## 6. Data schemas

```sql
CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,          -- short id / uuid
  client        TEXT NOT NULL,             -- 'claude' | 'codex'
  mode          TEXT NOT NULL,             -- 'deliverable' | 'interactive' | 'coordinated'
  role          TEXT,                      -- 'implementer'|'reviewer'|'decider'|'planner'|'solo'
  working_dir   TEXT NOT NULL,
  tmux_target   TEXT,                       -- 'session:window.pane' (interactive/attachable)
  status        TEXT NOT NULL,             -- starting|running|awaiting_input|awaiting_approval|done|failed|killed
  coordination_id TEXT,                    -- FK -> coordination_plans.id
  egress_allowlist TEXT,                   -- JSON array of domains, optional
  summary       TEXT,                      -- final result summary (for deliverables)
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  ended_at      INTEGER
);

CREATE TABLE coordination_plans (
  id            TEXT PRIMARY KEY,
  command_audit_id INTEGER NOT NULL,       -- originating command (FK -> audit_log.id)
  topology_json TEXT NOT NULL,             -- model-authored plan (participants, roles, sequence)
  decider_session_id TEXT,
  phase         TEXT NOT NULL,             -- planning|implementing|reviewing|revising|deciding|done|replanning
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE audit_log (                   -- append-only; no UPDATE/DELETE, ever
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,
  type          TEXT NOT NULL,             -- command|spawn|approval_request|approval_decision|
                                           -- tool_use|drive_write|memory_promotion|replan|status_change|error|dropped_message
  session_id    TEXT,
  coordination_id TEXT,
  source        TEXT NOT NULL,             -- 'signal:<sender>'|'dispatcher'|'session:<id>'|'dashboard'|'policy'
  payload_json  TEXT
);

CREATE TABLE approvals (                   -- supports the async Signal round-trip
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  tool_name     TEXT NOT NULL,
  request_json  TEXT NOT NULL,             -- proposed action + resolved path/scope
  status        TEXT NOT NULL,             -- pending|approved|denied|timeout
  decided_via   TEXT,                      -- signal|tty|dashboard|policy_auto
  requested_at  INTEGER NOT NULL,
  decided_at    INTEGER
);

CREATE TABLE memory_proposals (            -- child sessions propose; dispatcher promotes
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  category      TEXT NOT NULL,             -- convention|task_pattern|feedback|policy_candidate
  proposed_text TEXT NOT NULL,
  target_file   TEXT,                      -- e.g. memory/conventions/sip.md
  status        TEXT NOT NULL,             -- pending|promoted|rejected
  created_at    INTEGER NOT NULL,
  decided_at    INTEGER
);
```

Learning memory itself lives as markdown under `<home>/memory/` (e.g. `learnings.md`,
`task-patterns.md`, `conventions/<repo>.md`), git-tracked so promotions are diffable.

---

## 7. Core flows

### 7.1 Deliverable — CSA deck → Drive

1. Signal command received from allowlisted sender; logged (`type=command`).
2. Dispatcher classifies: deliverable, `claude`, new scratch dir, outputs to the synced
   Drive presentations folder.
3. Dispatcher reads relevant learning memory (deck-build pattern → template + asset paths).
4. Spawn ephemeral Claude session in scratch dir; preload your `writing-style` +
   `pptx` skills, the deck template + icon/asset paths, your outline.
5. Session builds the `.pptx`. Writing into scratch = auto-allow. Writing the final file
   to the **Drive folder = ask** → Signal prompt → I approve.
6. Session exits; dispatcher Signals "done, in /Drive/Presentations/…".
7. File syncs to my devices; I review and send feedback as a follow-up command → fresh
   revision session against the same file. Session emits a `memory_proposal` (e.g. "drop
   the subtitle on title slides") for dispatcher promotion.

### 7.2 Interactive — Claude Code for the SIP

1. Signal command; classified interactive, `claude`, existing repo.
2. Dispatcher locates the local SIP directory, launches a Claude session in a named tmux
   target, registers it (`mode=interactive`, `tmux_target=...`, `status=running`).
3. Dispatcher Signals the attach command / dashboard deep link.
4. I attach via Prompt/Blink over Tailscale SSH; steer live. Permission prompts answered
   in-TTY (I'm present). If it goes idle/needs input while I've stepped away, dispatcher
   Signals me. ("Brand new coding task" = same flow but dispatcher creates + `git init`s
   a new dir first.)

### 7.3 Coordinated — Claude implements / Codex reviews / Claude decides

1. Signal command; classified coordinated. Dispatcher (model) plans topology and echoes
   it to Signal for optional confirm.
2. Deterministic executor spawns Claude `implementer` + Codex `reviewer` on a shared
   working dir (worktree/branch convention). Default behavior: deliverable (runs to
   convergence, then notifies; attachable if I want to intervene).
3. FSM: implement → route diff to reviewer → route critique back → revise → decider
   (Claude) accepts/rejects. Only decider-accept lands changes. Each participant gated by
   its own permission policy (Codex under its coarser sandbox mode per §5.5).
4. On convergence, dispatcher Signals the result + summary; full implement/review/decide
   chain is in the audit log as discrete steps.

---

## 8. Tech stack

- **Language/runtime:** TypeScript / Node.
- **Dispatcher & Claude sessions:** Claude Agent SDK (TypeScript) — headless dispatcher,
  programmatic session spawn, and the `canUseTool` permission hook.
- **Codex sessions:** official `codex` CLI driven as a subprocess in tmux, using its
  exec/headless + sandbox modes (validate contract in Phase 0).
- **Messaging:** `signal-cli` (daemon/JSON-RPC mode), dedicated Twilio number.
- **State:** SQLite (`better-sqlite3`).
- **Interactive substrate:** tmux.
- **Remote access:** Tailscale (`tailscale serve` for the dashboard; Tailscale SSH for
  attach); tailnet ACLs.
- **Persistence:** `launchd` user agent for the dispatcher daemon.
- **Dashboard:** minimal TS web app (no heavy framework needed).

---

## 9. tmux & attach conventions

- Config used when creating panes: `set -g mouse on`, `set -g history-limit 50000`, and a
  bound key into copy-mode for a deterministic scrollback entry path. (Mouse mode routes
  wheel events into tmux scrollback rather than the terminal app's — validate the feel in
  Prompt on-device; Blink is the smoother fallback if Prompt fights the gesture. §12.)
- Naming: one tmux session per Switchboard session, target stored as `tmux_target` in the
  registry; e.g. `sw:<short-id>`.
- Attach path: dashboard/Signal provides the attach command; Tailscale SSH + `tmux attach
  -t <target>` is the robust path regardless of terminal app. Prompt URL-scheme deep
  linking is a nice-to-have to validate, not a dependency.
- For reviewing long deliverable output, prefer the dashboard log view over phone
  scrollback.

---

## 10. Build phases

- **Phase 0 — De-risk the unknowns (do first).**
  - Prove the Agent SDK `canUseTool` hook round-trip (intercept → external decision →
    feed back). The entire interaction model depends on this.
  - Confirm the Codex headless invocation + sandbox/permission contract and its
    granularity (§5.5 asymmetry).
  - Test tmux mouse scrolling in Prompt on-device.
- **Phase 1 — Core local loop.** Dispatcher daemon (`launchd`), SQLite registry + audit
  log, spawn solo `claude`/`codex` sessions in tmux, basic status. Drive it from the
  local terminal first; no remote yet.
- **Phase 2 — Control plane.** `signal-cli` with dedicated number + hard sender
  allowlist; command parse/classify; notifications; the permission hook → Signal approval
  loop with the §5.5 policy matrix.
- **Phase 3 — Dashboard.** Tailscale-served session list/status/log/kill + attach
  commands; iOS attach path.
- **Phase 4 — Memory.** Two-store memory; `memory_proposals` flow; curated promotion with
  audit provenance.
- **Phase 5 — Coordination.** Plan-then-execute engine; role primitives; deliverable-mode
  coordinated tasks.
- **Phase 6 — Learning loop.** Feedback capture; explicit Signal-confirmed promotion
  suggestions (incl. auto-allow candidates).

---

## 11. Directory layout (suggested)

```
<home: your productivity dir>/
  switchboard/
    src/
      dispatcher/        # intent parse, classify, plan, curate
      control/           # signal-cli adapter, dashboard server
      execution/         # session spawn/lifecycle, tmux, claude(SDK)/codex(subprocess)
      permissions/       # policy matrix + canUseTool hook + approval round-trip
      coordination/      # plan schema, validator, deterministic FSM executor
      state/             # sqlite access, schema, migrations
    config/
      policy.ts          # default permission matrix (editable)
      allowlist.ts       # signal sender allowlist
    switchboard.db       # sqlite
    launchd/             # com.switchboard.daemon.plist
  memory/                # curated learning memory (git-tracked)
    learnings.md
    task-patterns.md
    conventions/
```

---

## 12. Open items to validate

1. **Agent SDK permission hook surface** — exact `canUseTool` API, what context it
   provides (resolved paths?), and whether deny/allow round-trips cleanly with an
   external async decision. Highest-priority spike; the interaction model rests on it.
2. **Codex permission granularity** — whether Codex exposes any per-tool programmatic
   approval or only coarse sandbox modes. If coarse-only, accept the asymmetry: scope
   Codex working dirs tightly and reserve landing authority for the Claude decider.
3. **Prompt tmux scrolling** — confirm mouse mode feels right on-device; fall back to
   Blink if not.
4. **signal-cli approval latency** — confirm the send→reply→decide round-trip is fast and
   reliable enough to sit in front of a blocking tool call; tune approval timeouts and the
   timeout-default (deny) behavior.
5. **Drive sync timing** — confirm the review loop (write → sync to device → my feedback)
   is fast enough to feel responsive for the deliverable archetype.
6. **Coordinated-task cost/latency** — measure a real implement→review→revise→decide loop;
   confirm deliverable-mode (notify-on-convergence) is the right default vs. attaching.
