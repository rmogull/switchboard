/**
 * Typed error hierarchy. Every error carries a stable `code` so the control
 * plane can format it for Signal/dashboard without string-matching messages.
 */
export class SwitchboardError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

/** Configuration is missing or invalid — surfaced at startup, never mid-task. */
export class ConfigError extends SwitchboardError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("config_invalid", message, options);
  }
}

/** A required external binary (claude/codex/tmux/signal-cli/tailscale) is absent. */
export class DependencyError extends SwitchboardError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("dependency_missing", message, options);
  }
}

/**
 * An Invariant (§2) would be violated. These are bugs or attacks, never normal
 * flow — they must fail loud and abort the action, never be swallowed.
 */
export class InvariantViolation extends SwitchboardError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("invariant_violation", message, options);
  }
}

/** A session/coordination/approval lifecycle transition was illegal. */
export class StateError extends SwitchboardError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("state_error", message, options);
  }
}
