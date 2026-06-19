import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { ConfigError } from "../core/errors.js";
import { expandHome } from "../core/paths.js";
import { configSchema, type SwitchboardConfig } from "./schema.js";

export type { SwitchboardConfig } from "./schema.js";

/** A fully validated config with environment-specific paths resolved absolute. */
export interface ResolvedConfig extends SwitchboardConfig {
  /** Absolute runtime home directory (context root: memory, skills, assets). */
  home: string;
  /** Absolute operational state directory (db, scratch, sessions, logs). */
  stateDir: string;
  /** Absolute SQLite path. */
  dbPath: string;
  /** Where the config was loaded from (`<defaults>` if no file existed). */
  configPath: string;
}

/** Candidate config locations, in precedence order (first existing wins). */
export function configCandidates(): string[] {
  const fromEnv = process.env.SWITCHBOARD_CONFIG;
  const home = process.env.SWITCHBOARD_HOME;
  return [
    ...(fromEnv ? [fromEnv] : []),
    resolve(process.cwd(), "switchboard.config.json"),
    ...(home ? [join(expandHome(home), "switchboard", "switchboard.config.json")] : []),
    join(expandHome("~/.switchboard"), "switchboard.config.json"),
  ];
}

function readConfigFile(path: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (cause) {
    throw new ConfigError(`could not read config file at ${path}`, { cause });
  }
  try {
    return JSON.parse(raw);
  } catch (cause) {
    throw new ConfigError(`config file at ${path} is not valid JSON`, { cause });
  }
}

/**
 * Load and validate configuration. Precedence: built-in defaults < config file
 * < environment overrides. Throws ConfigError with a readable message on any
 * validation failure — config problems surface at startup, never mid-task.
 */
export function loadConfig(opts: { path?: string } = {}): ResolvedConfig {
  const explicit = opts.path;
  const path =
    explicit ?? configCandidates().find((c) => existsSync(c)) ?? "<defaults>";

  const fileData = path === "<defaults>" ? {} : readConfigFile(path);

  const parsed = configSchema.safeParse(fileData);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  • ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new ConfigError(`invalid configuration in ${path}:\n${issues}`);
  }

  const cfg = parsed.data;

  // Environment overrides win over the file.
  const homeRaw = process.env.SWITCHBOARD_HOME ?? cfg.home;
  const home = expandHome(homeRaw);
  const stateDir = cfg.stateDir ? expandHome(cfg.stateDir) : join(home, "switchboard");
  const dbPath = cfg.dbPath ? expandHome(cfg.dbPath) : join(stateDir, "switchboard.db");

  return { ...cfg, home, stateDir, dbPath, configPath: path };
}
