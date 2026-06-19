import { chmodSync } from "node:fs";

/**
 * Best-effort owner-only permissions for runtime state. These paths hold the control DB,
 * transcripts, the dashboard token, and Signal account context, so they must not be
 * group/world readable. Failures (not the owner, unsupported filesystem) are ignored —
 * the dir/file is still created; we only tighten when we can.
 */
export function chmodDir700(dir: string): void {
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* not owner / unsupported */
  }
}

export function chmodFile600(file: string): void {
  try {
    chmodSync(file, 0o600);
  } catch {
    /* not owner / unsupported */
  }
}
