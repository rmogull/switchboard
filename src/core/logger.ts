/**
 * Operational logging — distinct from the audit log (§5.6). This is for humans
 * tailing the daemon (`logs/switchboard.log`, stderr); the audit log is the
 * immutable record of consequential events in SQLite. Never conflate them: a
 * crash here loses debugging breadcrumbs, a gap there is a security incident.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

function emit(
  minLevel: LogLevel,
  bindings: Record<string, unknown>,
  level: LogLevel,
  msg: string,
  fields?: Record<string, unknown>,
): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
  const record = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...bindings,
    ...fields,
  };
  const line = JSON.stringify(record);
  if (level === "error" || level === "warn") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

export function createLogger(
  minLevel: LogLevel = (process.env.SWITCHBOARD_LOG_LEVEL as LogLevel) || "info",
  bindings: Record<string, unknown> = {},
): Logger {
  return {
    debug: (m, f) => emit(minLevel, bindings, "debug", m, f),
    info: (m, f) => emit(minLevel, bindings, "info", m, f),
    warn: (m, f) => emit(minLevel, bindings, "warn", m, f),
    error: (m, f) => emit(minLevel, bindings, "error", m, f),
    child: (b) => createLogger(minLevel, { ...bindings, ...b }),
  };
}
