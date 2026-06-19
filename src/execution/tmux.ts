import { run, runOk } from "./exec.js";

export interface TmuxOptions {
  /** tmux binary (resolved path or "tmux"). */
  binPath?: string;
  /**
   * Dedicated server socket name. Switchboard runs its own tmux server (`-L`)
   * so it never reads or clobbers the user's personal tmux config/sessions, and
   * so server-global options (mouse, history-limit) are safe to set.
   */
  socket?: string;
  /**
   * tmux config sourced when the server starts, via `-f` on the first
   * new-session. This is the only reliable way to apply `history-limit` before
   * panes are created — `start-server` with no sessions exits immediately, so
   * setting options out-of-band doesn't work.
   */
  configFile?: string;
}

export interface NewSessionOptions {
  name: string;
  cwd: string;
  /** Command the pane runs. If omitted, the user's default shell. */
  command?: string;
  /** Extra environment for the pane (tmux 3.0+ `-e KEY=VAL`). */
  env?: Record<string, string>;
}

/**
 * The validated default config (spec §9 / tmux-probe.conf). Written to disk by
 * the session manager and passed as `configFile` unless the user supplies their
 * own `tmux.configPath`.
 */
export function defaultTmuxConfig(historyLimit: number): string {
  return [
    "set -g mouse on",
    `set -g history-limit ${historyLimit}`,
    "set -g mode-keys vi",
    "bind e copy-mode",
    "set -g focus-events on",
    "set -g status-interval 5",
    // Snappier keys over mosh (no ESC ambiguity delay).
    "set -s escape-time 0",
    // Advertise 256-color + true-color so the Claude TUI renders correctly when
    // attached from a phone/iPad terminal over mosh.
    'set -g default-terminal "tmux-256color"',
    "set -ga terminal-overrides ',*:Tc'",
    // --- Mouse-wheel scrolling, tuned for touch terminals (Prompt/Blink) over
    // mosh. With `mouse on`, wheel events normally arrow-spam the foreground app.
    // This routes a wheel-up on a non-mouse pane INTO copy-mode so you scroll the
    // tmux scrollback by drag/flick; full-screen mouse apps (that request mouse
    // reporting, e.g. the Claude TUI) still receive the wheel themselves. NEEDS
    // ON-DEVICE TESTING — touch-scroll behavior differs across iOS terminals.
    "bind -n WheelUpPane if-shell -F -t = \"#{mouse_any_flag}\" \"send-keys -M\" \"if -Ft= '#{pane_in_mode}' 'send-keys -M' 'copy-mode -e; send-keys -M'\"",
    "bind -n WheelDownPane if-shell -F -t = \"#{mouse_any_flag}\" \"send-keys -M\" \"if -Ft= '#{pane_in_mode}' 'send-keys -M' 'send-keys -M'\"",
    // Drag-to-scroll inertia: smaller scroll step so a touch flick moves a sane
    // number of lines.
    "bind -T copy-mode-vi WheelUpPane send-keys -X -N 2 scroll-up",
    "bind -T copy-mode-vi WheelDownPane send-keys -X -N 2 scroll-down",
    // iOS scrollback (Prompt/mosh): a gesture can't drive tmux scrollback — tmux
    // renders a fixed canvas, so scrolled-off lines never reach the client's native
    // scrollback, and Prompt doesn't emit wheel events tmux maps to copy-mode
    // (anthropics/claude-code#67289; mobile-shell/mosh#2; leancrew.com/prompt-forever).
    // The working path is copy-mode via a NO-PREFIX key on the iOS keyboard bar: tap
    // PageUp to enter copy-mode and page up through the 50k-line history; PageDown
    // pages down; scrolling to the bottom auto-exits (-e); q/Escape also exits.
    "bind -n PageUp copy-mode -eu",
    "bind -T copy-mode-vi PageUp send -X page-up",
    "bind -T copy-mode-vi PageDown send -X page-down",
    "",
  ].join("\n");
}

/**
 * Thin wrapper over the tmux CLI for the interactive substrate (spec §9). One
 * tmux session per Switchboard session. Sessions are named `<prefix>-<id>` —
 * a hyphen, not the spec's illustrative `sw:<id>`, because `:` is tmux's
 * session:window.pane target separator and unsafe in a session name.
 */
export class Tmux {
  private readonly bin: string;
  private readonly socket: string;
  private readonly configFile: string | undefined;

  constructor(opts: TmuxOptions = {}) {
    this.bin = opts.binPath ?? "tmux";
    this.socket = opts.socket ?? "switchboard";
    this.configFile = opts.configFile;
  }

  /** Global flags before a subcommand. `-f` is honored only when this call starts the server. */
  private args(...rest: string[]): string[] {
    const globals = ["-L", this.socket];
    if (this.configFile) globals.push("-f", this.configFile);
    return [...globals, ...rest];
  }

  get socketName(): string {
    return this.socket;
  }

  async isAvailable(): Promise<boolean> {
    try {
      await runOk(this.bin, ["-L", this.socket, "-V"]);
      return true;
    } catch {
      return false;
    }
  }

  async hasSession(name: string): Promise<boolean> {
    const r = await run(this.bin, ["-L", this.socket, "has-session", "-t", name]);
    return r.code === 0;
  }

  /**
   * Create a detached session. The first such call starts the Switchboard tmux
   * server and loads `configFile` (applying history-limit before the pane
   * exists); later calls join the already-configured server.
   */
  async newSession(opts: NewSessionOptions): Promise<void> {
    const a = this.args("new-session", "-d", "-s", opts.name, "-c", opts.cwd);
    for (const [k, v] of Object.entries(opts.env ?? {})) {
      a.push("-e", `${k}=${v}`);
    }
    if (opts.command) a.push(opts.command);
    await runOk(this.bin, a);
  }

  /**
   * Replace the command running in a session's pane IN PLACE — same pane/window,
   * so the tmux target (and any attached client) is preserved. `-k` kills the
   * current command first; `-c` pins the start directory so the new command runs
   * in the original cwd. Used to convert a gated SDK session into a native `claude`
   * CLI session without tearing down the pane the operator may be attached to.
   */
  async respawnPane(target: string, command: string, cwd?: string): Promise<void> {
    const rest = ["respawn-pane", "-k"];
    if (cwd) rest.push("-c", cwd);
    rest.push("-t", target, command);
    await runOk(this.bin, this.args(...rest));
  }

  /**
   * Inject input into a session's active pane — the mechanism behind the Signal
   * control surface (the dispatcher relays a Signal message as keystrokes).
   * `enter` appends a carriage return so the line is submitted.
   */
  async sendKeys(name: string, keys: string, enter = true): Promise<void> {
    await runOk(this.bin, ["-L", this.socket, "send-keys", "-t", name, keys]);
    if (enter) {
      await runOk(this.bin, ["-L", this.socket, "send-keys", "-t", name, "Enter"]);
    }
  }

  /**
   * Capture pane contents — the read side of the Signal relay and the dashboard
   * log view. `lines` caps how far back from the bottom to read.
   */
  async capturePane(name: string, lines?: number): Promise<string> {
    const a = ["-L", this.socket, "capture-pane", "-p", "-t", name];
    if (lines !== undefined) a.push("-S", `-${lines}`);
    const r = await runOk(this.bin, a);
    return r.stdout;
  }

  async listSessions(): Promise<string[]> {
    const r = await run(this.bin, [
      "-L",
      this.socket,
      "list-sessions",
      "-F",
      "#{session_name}",
    ]);
    if (r.code !== 0) return []; // no server / no sessions
    return r.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  async killSession(name: string): Promise<void> {
    await run(this.bin, ["-L", this.socket, "kill-session", "-t", name]);
  }

  /** Tear down the whole Switchboard tmux server (all sessions). */
  async killServer(): Promise<void> {
    await run(this.bin, ["-L", this.socket, "kill-server"]);
  }

  /** Local attach command for display (the dashboard/Signal hand this to you). */
  attachCommand(name: string): string {
    return `${this.bin} -L ${this.socket} attach -t ${name}`;
  }
}
