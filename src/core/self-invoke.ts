import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SwitchboardError } from "./errors.js";

/** Walk up from this module to the package root (the dir containing package.json). */
export function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new SwitchboardError("package_root", "could not locate the switchboard package root");
}

/**
 * Argv to re-invoke the Switchboard CLI for a subcommand (e.g. `run-session`).
 * Prefers the built dist; falls back to running source via tsx in development.
 */
export function cliInvocationArgs(args: string[]): string[] {
  const root = packageRoot();
  const dist = join(root, "dist/cli/index.js");
  if (existsSync(dist)) return [process.execPath, dist, ...args];
  return [
    process.execPath,
    join(root, "node_modules/.bin/tsx"),
    join(root, "src/cli/index.ts"),
    ...args,
  ];
}

function shellQuote(s: string): string {
  return /^[A-Za-z0-9_./:=-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}

/** Join argv into a single shell-safe command string (for tmux's command arg). */
export function shellJoin(args: string[]): string {
  return args.map(shellQuote).join(" ");
}
