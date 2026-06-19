/**
 * How an interactive session is steered (spec §5.4 + the multi-surface
 * design). Remote interactive Claude defaults to the GATED SDK streaming runner;
 * the surface determines how you reach it:
 *  - tmux           — direct `tmux attach` over Tailscale (console-level)
 *  - signal         — dispatcher relays Signal turns into the SDK stream
 *  - remote_control — the official app (Claude: `claude --remote-control`;
 *                     Codex: the Codex desktop app's QR — outside the CLI path)
 *  - local_console  — explicit at-desk RAW `claude` CLI in the pane (NOT gated by
 *                     Switchboard's policy; answer prompts natively in-TTY). Use
 *                     only when sitting at the machine; the remote default is the
 *                     gated streaming runner.
 *  - ironcurtain    — Docker-sandboxed session on the shared IronCurtain daemon;
 *                     no tmux pane, created + driven over its web-ui WS, with
 *                     escalations bridged into the normal approval → Signal path.
 */
export type ControlSurface =
  | "tmux"
  | "signal"
  | "remote_control"
  | "local_console"
  | "ironcurtain";

/** Codex sandbox scope, chosen at spawn (§5.5 asymmetry; validated by probe.sh). */
export type CodexSandbox = "read-only" | "workspace-write" | "danger-full-access";
