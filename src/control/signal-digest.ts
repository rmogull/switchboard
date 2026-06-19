export interface DigestEvent {
  kind: "status" | "result" | "notice";
  text: string;
}

const RESULT_CLIP = 1400;

/**
 * The output verbosity-split chokepoint. Maps a runner event to a single
 * Signal-ready line, or null to suppress it. Signal receives status + approval
 * asks (asks are produced by the approval path) + final result ONLY — never the
 * token-by-token transcript, which stays in the pane (and, in Inc3, the
 * dashboard transcript). All Signal-bound output flows through here so the phone
 * is never spammed with assistant deltas.
 */
export function toSignalDigest(ev: DigestEvent, sessionId: string): string | null {
  const text = ev.text.trim();
  if (!text) return null;
  if (ev.kind === "status") return `▶️ ${sessionId}: ${text}`;
  if (ev.kind === "result") {
    const clip =
      text.length > RESULT_CLIP
        ? `${text.slice(0, RESULT_CLIP)} …(full output in the pane / dashboard)`
        : text;
    return `💬 ${sessionId}:\n${clip}`;
  }
  return `ℹ️ ${sessionId}: ${text}`;
}

/**
 * Inverse of the operator-facing formats: recover the session id from the text of
 * a message the operator replied to (Signal's native quote). Handles every shape
 * Switchboard sends with an id — result/status/notice digests (`💬 <id>: …`), the
 * approval prompt (`Session <id> wants …`), the spawn notice (`spawned <id> …`),
 * and the steering ack (`→ <id>: …`). Returns null if no id is recognizable. A
 * false positive is harmless: the dispatcher only acts on it if it names a real
 * session row. Session ids are lowercase alphanumeric + hyphen.
 */
export function sessionIdFromQuotedText(quoted: string): string | null {
  const t = quoted.trim();
  const ID = "([a-z0-9][a-z0-9-]*)";
  // Approval prompt — match before the generic ": " form (its leading token is a word).
  let m = t.match(new RegExp(`Session\\s+${ID}\\s+wants\\b`, "i"));
  if (m) return m[1]!.toLowerCase();
  m = t.match(new RegExp(`^spawned\\s+${ID}\\b`, "i"));
  if (m) return m[1]!.toLowerCase();
  m = t.match(new RegExp(`^→\\s*${ID}:`));
  if (m) return m[1]!.toLowerCase();
  // Result/status/notice digest: a leading emoji/space run, then `<id>:`.
  m = t.replace(/^[^A-Za-z0-9]+/, "").match(new RegExp(`^${ID}:`, "i"));
  if (m) return m[1]!.toLowerCase();
  return null;
}
