import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { expandHome } from "../core/paths.js";

const SKIP = new Set(["node_modules", "dist", "build", "target", "vendor", "Pods"]);

function childDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIP.has(e.name))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Find a project directory by name under the configured code roots (§5.1) — so a
 * command can reference a repo by name without the operator knowing its full
 * path. Searches two levels deep, preferring an exact (case-insensitive) name
 * match over a partial one. Returns undefined if nothing matches.
 */
export function findProjectDir(name: string, roots: string[]): string | undefined {
  const target = name.toLowerCase();
  if (target.length < 2) return undefined;
  const exact: string[] = [];
  const partial: string[] = [];

  const consider = (entryName: string, path: string) => {
    const n = entryName.toLowerCase();
    if (n === target) exact.push(path);
    else if (n.includes(target) || (target.length >= 4 && target.includes(n) && n.length >= 4)) partial.push(path);
  };

  for (const rootRaw of roots) {
    const root = expandHome(rootRaw);
    if (!existsSync(root)) continue;
    for (const l1 of childDirs(root)) {
      const p1 = join(root, l1);
      consider(l1, p1);
      if (exact.length) return exact[0]; // early exit on a depth-1 exact hit
      for (const l2 of childDirs(p1)) consider(l2, join(p1, l2));
    }
  }
  return exact[0] ?? partial[0];
}
