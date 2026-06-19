# Contributing

Thanks for your interest in Switchboard. It's a security-sensitive orchestrator, so the
bar for changes that touch the permission system, the control plane, or the coordination
executor is high — but the codebase is small, typed, and well-tested, and contributions
are welcome.

## Development setup

```bash
npm install
npm run typecheck     # tsc --noEmit (strict)
npm test              # vitest — fast, mostly hermetic (real tmux + git for a few)
npm run build         # tsup → dist/cli/index.js
```

Node 26 is pinned (committed `.nvmrc`/`.node-version`); `engines` is `>=22`. A few tests
drive the **real `tmux` and `git` binaries** (install both) — they create tmux sessions and
run actual git operations against scratch repos; none require AI credentials or network
access.

**`better-sqlite3` is a native module.** If you switch Node major versions after installing
(e.g. via `nvm`/`brew`), the compiled addon's ABI no longer matches and you'll hit a
`NODE_MODULE_VERSION` error. Fix it with:

```bash
npm rebuild better-sqlite3
```

`switchboard doctor` runs a native-module preflight and prints this exact remedy (and exits
non-zero) on an ABI mismatch instead of crashing.

## Ground rules

- **TypeScript, strict.** `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, and
  friends are on. Keep it that way.
- **The invariants in [SECURITY.md](SECURITY.md) are non-negotiable.** If a change relaxes
  a permission default, widens what reaches an agent, or moves landing authority, call it
  out explicitly in the PR and add tests.
- **Fail closed.** Anything not provably safe should resolve to `ask`/`deny`, never `allow`.
- **No personal data in code.** Everything environment-specific lives in config. The code
  must run for anyone from a clean checkout + their own config.
- **Tests with the change.** New behavior ships with tests; security-relevant logic ships
  with adversarial/regression tests.

## Layout

```
src/
  core/         ids, clock, logger, errors, deps, paths, self-invoke
  config/       zod schema + loader
  state/        sqlite schema (embedded), db, typed repositories
  permissions/  policy matrix + canUseTool hook + approval gateway + gated SDK options
  control/      signal-cli adapter, approval notifier, dashboard, tailscale
  execution/    exec, tmux, session manager, gated query, claude runner
  coordination/ plan + validator, FSM executor, real participant runner, git, coordinator
  dispatcher/   classify, dispatcher, launchd daemon
  memory/       curated markdown memory + proposal/promotion service
  learning/     auto-allow suggestions + rules + service
  launchd/      plist render + install
  cli/          the switchboard CLI
```

## Commits & PRs

- Keep commits scoped and the message explanatory (what + why, not just what).
- Run `npm run typecheck && npm test && npm run build` before pushing.
- For anything touching `permissions/`, `coordination/`, or `control/signal*`, describe the
  security reasoning in the PR.
