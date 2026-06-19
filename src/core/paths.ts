import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

/** Expand a leading `~` and resolve to an absolute path. */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return isAbsolute(p) ? p : resolve(p);
}

/**
 * True if `child` resolves to `parent` or somewhere beneath it. Prefix-safe
 * (/a/projevil is not under /a/proj) and traversal-safe. Used wherever a path
 * derived from tainted input must be contained (working dirs, memory files).
 */
export function isPathUnder(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
