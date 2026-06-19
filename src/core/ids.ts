import { randomBytes, randomUUID } from "node:crypto";

/**
 * Short, URL-safe, human-legible session ids (e.g. `a1b2c3d4`).
 * Used for tmux target names (`sw:<id>`) and registry primary keys, so they
 * need to be shell- and tmux-safe: lowercase hex, no separators.
 */
export function shortId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 8);
}

/** A short base36 disambiguator (e.g. `k4p`) appended to descriptive session ids
 * to keep them unique. Crypto-backed (no Math.random), lowercase [a-z0-9]. */
export function idSuffix(len = 3): string {
  const bytes = randomBytes(len);
  let s = "";
  for (let i = 0; i < len; i++) s += (bytes[i]! % 36).toString(36);
  return s;
}

/** Full uuid for things that never become shell tokens (approvals, proposals). */
export function uuid(): string {
  return randomUUID();
}
