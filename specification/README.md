# Phase 0 — De-risking spikes

Three runnable probes for the unknowns in `orchestrator-spec.md` that are "works or it
doesn't" — validate these on your Mac **before** building scaffolding around them. Each
maps to a spec decision and tells you what a failure changes.

| Spike | Proves | Spec section | If it FAILS |
|-------|--------|--------------|-------------|
| 1. canUseTool round-trip | The Claude Agent SDK can **await an out-of-band (Signal) decision** and blocks the tool until it resolves | §5.5 permission system | The whole Signal-approval interaction model needs rethinking — fall back to dashboard-only approvals |
| 2. Codex sandbox | Codex confinement is **coarse, per-spawn sandbox scope** with no per-action external callback | §5.5 Codex asymmetry, §5.7 | If out-of-scope writes succeed, Codex sandboxing on this machine is broken — don't run Codex unattended until fixed |
| 3. tmux + Prompt scroll | Mouse-mode scrollback is **comfortable on-device in Prompt** | §9 tmux & attach | Use Blink instead of Prompt; lean on the dashboard log view for review |

> Build-sandbox validation already done for you: Spike 1 **typechecks against the real
> `@anthropic-ai/claude-agent-sdk` v0.3.177** (its `CanUseTool` signature matches the
> probe exactly), and Spike 3's `tmux-probe.conf` **loads cleanly** with every setting
> applied. The probes still need to *run* on your Mac, because that's where the
> authenticated CLIs, your subscriptions, and your phone live — none of which exist in
> the build sandbox.

---

## Prerequisites

- **Spike 1:** Node 20+, and Claude Code / the Agent SDK authenticated to your Max plan.
  (The probe drives a real `query()`, so it consumes Max usage and needs working auth.)
- **Spike 2:** `codex` CLI installed and logged in (ChatGPT Pro). Runs real `codex exec`
  calls, so it consumes usage.
- **Spike 3:** `tmux` (`brew install tmux`), and your phone with Prompt (and/or Blink),
  reachable to the Mac over Tailscale for the on-device part.

Each probe is self-contained and writes only to `/tmp` scratch dirs it cleans up.

---

## Run order & what to look for

### Spike 1 — the load-bearing one, do it first

```bash
cd spike1-canusetool
npm install
npm run probe
```

It runs an allow pass and a deny pass. When it prints a **pending decision**, approve or
deny it **from a second terminal — or from your phone over Tailscale** — with the printed
`curl`. That out-of-band step is the whole point: it mirrors answering a permission
prompt over Signal while away from the desk.

**PASS** = callback fired, "SDK blocked for: N ms" is clearly > 0 (it genuinely waited
for your reply), allow created the file, deny prevented it. That means Signal-mediated
per-action approval is viable and §5.5 stands as written.

The `/decide?...&behavior=allow|deny` endpoint is exactly the shape the real Signal
handler implements; testing it from your phone now also de-risks the Tailscale path.

### Spike 2 — characterize Codex confinement

```bash
cd spike2-codex
bash probe.sh
```

It dumps your build's real `codex exec` flag surface (so you're trusting your installed
version, not docs), then runs three real `codex exec` calls: in-scope write under
`workspace-write` (should succeed), out-of-scope write under `workspace-write` (should be
**blocked**), and a write under `read-only` (should be **blocked**).

**PASS** confirms the asymmetry the spec already accounts for: Codex gives you sandbox
scope chosen at spawn, not an await-my-reply callback. So coordinated tasks keep landing
authority on the **Claude decider**, and Codex sessions get tightly-scoped working dirs.
**The one result to act on:** if the out-of-scope write *succeeds*, sandboxing on this
machine is misconfigured — fix it before any unattended Codex session.

### Spike 3 — scroll feel on-device

```bash
cd spike3-tmux
bash probe.sh
```

Sets up a tmux session (proposed `tmux-probe.conf`) holding 5000 lines, then prints how
to attach locally and from your phone and exactly what to check: two-finger/wheel scroll
into scrollback, `prefix + e` as the deterministic copy-mode entry that doesn't depend on
the gesture, and selection/copy.

**PASS** = comfortable review in Prompt. If the swipe fights tmux (the known rough edge),
try Blink, and remember the dashboard log view is the better surface for reviewing
finished deliverable output regardless.

---

## After Phase 0

If 1 passes and 2 behaves as expected, the two hardest assumptions in the spec hold and
you can build Phase 1 (core local loop) with confidence. If 1 fails, resolve the approval
channel question before anything else — it's upstream of the entire control plane.
