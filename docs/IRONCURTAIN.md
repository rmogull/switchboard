# IronCurtain — optional sandboxed execution backend

> **Status: EXPERIMENTAL, owner-only for v1.** Off by default. Treat it as an
> advanced opt-in, not a supported install path. Most users should leave it disabled.

IronCurtain (the `ironcurtain`/provos binary) is an optional execution backend that runs
sessions inside a **Docker-sandboxed** container instead of a local tmux pane. Switchboard
launches one long-lived `ironcurtain daemon` and creates sandboxed sessions over its
localhost web-UI WebSocket, bridging the sandbox's escalation prompts into Switchboard's
normal approval → Signal/dashboard path. A second dashboard tab ("Sandboxed") surfaces
these sessions; they have no tmux pane, so the usual `attach` does not apply.

## Prerequisites

These are **in addition** to Switchboard's core requirements, and are **not** needed for a
normal install:

- **Docker** installed and running (IronCurtain runs each session in a container).
- The external **`ironcurtain`/provos binary** installed (default path
  `/opt/homebrew/bin/ironcurtain`).
- **Node 24** — and *only* Node 24 — for the IronCurtain daemon.

### Node 24 is security-critical

IronCurtain's isolated-vm has no Node 26 prebuild, and **under Node 26 its V8 sandbox
silently disables** — a security-critical failure, not a loud error. The IronCurtain
backend therefore runs under a pinned Node 24 interpreter (`ironcurtain.nodePath`), and the
daemon manager verifies that interpreter's major version before trusting the sandbox.
Switchboard itself still runs on Node 26; only the IronCurtain child process uses Node 24.
Install it (e.g. `brew install node@24`); the default `nodePath` points at
`/opt/homebrew/opt/node@24/bin/node`.

## Enabling it

Set `ironcurtain.enabled: true` in `switchboard.config.json` and configure the
`ironcurtain.*` block. All keys (with defaults from
[`switchboard.config.example.json`](../switchboard.config.example.json) and
`src/config/schema.ts`):

| Key | Default | Meaning |
|-----|---------|---------|
| `enabled` | `false` | Opt-in switch for the whole backend. |
| `nodePath` | `/opt/homebrew/opt/node@24/bin/node` | Node 24 interpreter used to launch IronCurtain (see above — must be Node 24). |
| `binPath` | `/opt/homebrew/bin/ironcurtain` | Absolute path to the installed `ironcurtain` entry (run via `nodePath`, not its own shebang). |
| `webPort` | `7400` | Web-UI WebSocket port the daemon binds (`--web-port`). |
| `stateFile` | `~/.ironcurtain/web-ui.json` | Endpoint state file the daemon writes (`{port,host,token}`); a leading `~` is expanded. |
| `personasDir` | `~/.ironcurtain/personas` | Root holding the hand-authored, pre-compiled personas (one directory per persona). |
| `defaultPersona` | *(unset; example uses `vuln-discovery`)* | Persona used when a sandboxed session is spawned without an explicit one. |
| `endpoint` | *(unset)* | Pin `{host, port, token}` explicitly (e.g. when the daemon runs as another user); otherwise discovered from `stateFile`. |
| `maxWebSessions` | `5` | Mirror of IronCurtain's hardcoded web-session cap; pre-checked before creating a session. |

After enabling, run `switchboard doctor` to validate config, then spawn a sandboxed session:

```bash
switchboard spawn --client claude --mode interactive --persona vuln-discovery
# --persona implies --control ironcurtain; the session appears on the dashboard's Sandboxed tab.
```

A sandboxed session has no tmux pane, so `switchboard spawn` points you at the dashboard's
Sandboxed tab rather than printing an attach command.

## Personas

Personas live **under `~/.ironcurtain/personas`** (`ironcurtain.personasDir`), **not in this
repo**. Each persona is its own directory of hand-authored, pre-compiled definitions. The
example config ships `vuln-discovery` as the default persona name; author or install your
own under that directory.

## Notes & limits

- Spawning a sandboxed session is synchronous and can take tens of seconds (cold container
  boot).
- Off-allowlist actions inside the sandbox escalate through the normal Switchboard approval
  path — so you still approve consequential actions over Signal or the dashboard.
- This backend is experimental; expect rough edges and treat it as owner-only until it is
  promoted past v1.
