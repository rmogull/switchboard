import type { Archetype, Client } from "../state/types.js";
import type { ControlSurface } from "../execution/types.js";

export interface ClassifiedCommand {
  archetype: Archetype;
  client: Client;
  /** Steering surface; only meaningful for interactive. Default (undefined) =
   * the gated SDK streaming runner. 'local_console' = explicit raw at-desk CLI.
   * 'ironcurtain' = a Docker-sandboxed session (leading 'sandbox'/'ironcurtain'). */
  control?: ControlSurface;
  /** IronCurtain persona for a sandboxed session (parsed from '--persona x' / 'persona:x'). */
  persona?: string;
  /** Matched config repo name, if the command referenced a known repo. */
  repo?: string;
  /** Explicit working directory path mentioned in the command (e.g. "in /tmp"). */
  workingDir?: string;
  /** A project/directory NAME to search for under code roots (when no exact path). */
  dirHint?: string;
  /** Domains the task may reach without prompting (parsed from "allow domains: ..."). */
  egressAllowlist?: string[];
  /** The instruction handed to the worker session. */
  task: string;
  raw: string;
}

const GENERIC_DIR_WORDS = new Set([
  "new", "a", "an", "the", "my", "your", "this", "that", "it", "some",
  "session", "claude", "codex", "drive", "directory", "folder", "project", "repo",
]);

const CODEX_RE = /\bcodex\b/i;
const LOCAL_CONSOLE_RE = /\b(local console|local cli|raw cli|at[- ]desk|desktop console)\b/i;
// A LEADING 'sandbox'/'ironcurtain' keyword routes the task to the Docker-sandboxed
// IronCurtain backend. Required at the start (not mid-sentence) so an ordinary task
// that merely mentions "sandbox" doesn't accidentally route there.
const IRONCURTAIN_RE = /^(?:sandbox|ironcurtain)\b/i;
const PERSONA_RE = /(?:--persona[=\s]+|persona:\s*)([a-z0-9._-]+)/i;
const COORD_RE = /\b(coordinate|coordinated|review between|implement(?:s|ing)?\s+and\s+review|both\s+claude\s+and\s+codex|claude\s+and\s+codex|codex\s+and\s+claude)\b/i;
const INTERACTIVE_RE = /\b(launch|interactive|live session|spin up|so i can|let me|steer|attach|make (?:some )?changes|work on)\b/i;
const DELIVERABLE_RE = /\b(build|create|make|generate|produce|write up|put (?:it|this) in|deliver|draft)\b/i;

/**
 * Classify a vetted command into archetype/client/target (spec §5.1). This is a
 * deterministic first pass — fast, free, and testable. A future enhancement runs
 * the dispatcher model for ambiguous natural language, but the structured output
 * shape stays identical, so downstream code is unaffected.
 *
 * The command text is DATA (Invariant 2): it is parsed into a structured command
 * but never re-interpreted as new instructions once a session is running.
 */
export function classifyCommand(
  text: string,
  opts: { repos: Record<string, string> },
): ClassifiedCommand {
  const raw = text;
  const t = text.trim();

  // Coordination takes precedence: it names multiple participants.
  let archetype: Archetype;
  if (COORD_RE.test(t)) archetype = "coordinated";
  else if (INTERACTIVE_RE.test(t)) archetype = "interactive";
  else if (DELIVERABLE_RE.test(t)) archetype = "deliverable";
  else archetype = "interactive"; // safest default: a steerable session, not an unattended run

  // Client: codex if named (and not coordinated, where Claude is the primary/decider).
  const client: Client = archetype !== "coordinated" && CODEX_RE.test(t) ? "codex" : "claude";

  // Repo: first known repo name mentioned as a whole word.
  let repo: string | undefined;
  for (const name of Object.keys(opts.repos)) {
    const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (re.test(t)) {
      repo = name;
      break;
    }
  }

  // Egress allowlist: "allow domains: a.com, b.com" or "egress: a.com b.com".
  // Capture stops at the first shell metacharacter, so a sender can't smuggle
  // extra domains past `&&`/`|`/`;`/`$`/backticks (e.g. "a.com && curl evil.com"
  // yields only a.com). Each token must also be a strict bare domain.
  let egressAllowlist: string[] | undefined;
  const eg = t.match(/\b(?:allow domains?|egress)\s*[:=]\s*([^\n;|&$`<>()]+)/i);
  if (eg && eg[1]) {
    const domains = eg[1]
      .split(/[\s,]+/)
      .map((d) => d.trim().toLowerCase())
      .filter((d) => /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(d));
    if (domains.length) egressAllowlist = domains;
  }

  // Working directory hints — only for archetypes that operate IN a directory
  // (deliverables go to scratch and write outputs to Drive, not a project dir).
  let workingDir: string | undefined;
  let dirHint: string | undefined;
  if (archetype !== "deliverable" && !repo) {
    const pathM = t.match(/(?:\b(?:in|into|inside|under|at)\s+)(~?\/[\w./-]+)/i);
    if (pathM) {
      workingDir = pathM[1];
    } else {
      const before = t.match(/\b([A-Za-z0-9][\w.-]{2,})\s+(?:director(?:y|ies)|dir|folder|project|repo|repository|codebase)\b/i);
      const after = t.match(/\b(?:in|into|inside|for|on)\s+(?:my\s+|the\s+|your\s+)?([A-Za-z0-9][\w.-]{2,})\b/i);
      const cand = before?.[1] ?? after?.[1];
      if (cand && !GENERIC_DIR_WORDS.has(cand.toLowerCase())) dirHint = cand;
    }
  }

  const cmd: ClassifiedCommand = { archetype, client, task: t, raw };
  if (repo) cmd.repo = repo;
  if (workingDir) cmd.workingDir = workingDir;
  if (dirHint) cmd.dirHint = dirHint;
  if (egressAllowlist) cmd.egressAllowlist = egressAllowlist;
  // Interactive defaults to the gated SDK streaming runner; honor an explicit
  // request for the raw at-desk console instead.
  if (archetype === "interactive" && LOCAL_CONSOLE_RE.test(t)) cmd.control = "local_console";

  // A leading 'sandbox'/'ironcurtain' routes to the Docker-sandboxed backend (takes
  // precedence over the surface above). The keyword + any 'persona:' token are
  // stripped from the task so only the instruction reaches the sandboxed agent.
  if (IRONCURTAIN_RE.test(t)) {
    cmd.control = "ironcurtain";
    const pm = t.match(PERSONA_RE);
    if (pm) cmd.persona = pm[1]!.toLowerCase();
    cmd.task = t.replace(IRONCURTAIN_RE, "").replace(PERSONA_RE, "").replace(/\s+/g, " ").trim();
  }
  return cmd;
}
