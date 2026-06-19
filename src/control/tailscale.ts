import type { Logger } from "../core/logger.js";
import { run } from "../execution/exec.js";

/**
 * Expose the localhost dashboard on the tailnet via `tailscale serve` (§3/§5.3).
 * No inbound public port — Tailscale terminates TLS and authenticates by tailnet
 * identity. Gated on config (default off); the daemon only calls this when the
 * operator opts in.
 */
export async function tailscaleServe(
  binPath: string,
  port: number,
  log: Logger,
): Promise<string | null> {
  const r = await run(binPath, ["serve", "--bg", String(port)]);
  if (r.code !== 0) {
    log.warn("tailscale serve failed", { code: r.code, err: r.stderr.trim() });
    return null;
  }
  // Best-effort: read back the served URL from status.
  const status = await run(binPath, ["serve", "status"]);
  const url = status.stdout.match(/https?:\/\/\S+/)?.[0] ?? null;
  log.info("dashboard served on tailnet", { port, url });
  return url;
}

export async function tailscaleServeOff(binPath: string, port: number): Promise<void> {
  await run(binPath, ["serve", "--bg", String(port), "off"]);
}
