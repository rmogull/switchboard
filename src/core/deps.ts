import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * Resolve an external binary to an absolute path. Switchboard drives the
 * official CLIs as subprocesses (Invariant 1) and never bundles them, so it must
 * locate them at runtime: an explicit configured path if given, otherwise PATH.
 * Returns null when the binary cannot be found.
 */
export function resolveBinary(name: string, explicitPath?: string): string | null {
  if (explicitPath) return existsSync(explicitPath) ? explicitPath : null;
  try {
    const out = execFileSync("which", [name], { encoding: "utf8" }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

export interface DependencyStatus {
  name: string;
  required: boolean;
  path: string | null;
  note?: string;
}
