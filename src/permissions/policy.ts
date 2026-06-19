import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

import type { PolicyDecision } from "../config/schema.js";
import type { LearnedRule } from "../learning/rules.js";

/**
 * Permission policy (spec §5.5). Maps a Claude tool-use request to a policy
 * action, then to a decision. The security stance is FAIL CLOSED: anything that
 * can't be confidently classified as safe resolves to `ask`, never `allow`.
 *
 * Decisions are advisory inputs to the canUseTool hook, which turns `ask` into
 * an out-of-band Signal/dashboard approval. This module is pure and synchronous
 * so the whole matrix is exhaustively unit-testable.
 */

export type PolicyAction =
  | "read" // reads are low-consequence (no state change)
  | "write_in_workdir"
  | "write_outside_workdir"
  | "delete"
  | "network_egress"
  | "destructive_shell"
  | "build_shell"
  | "interpreter_shell" // python/node/ruby/perl/sh -c … — arbitrary code; gated only when unattended
  | "spawn_session"
  | "change_sharing"
  | "unknown";

/** Default matrix (§5.5). `unknown` fails closed to ask. */
export const DEFAULT_MATRIX: Record<PolicyAction, PolicyDecision> = {
  read: "allow",
  write_in_workdir: "allow",
  write_outside_workdir: "ask",
  delete: "ask",
  network_egress: "ask",
  destructive_shell: "ask",
  build_shell: "allow",
  // Interpreters auto-allow at the desk; evaluate() upgrades to ask in UNATTENDED sessions.
  interpreter_shell: "allow",
  spawn_session: "ask",
  change_sharing: "ask",
  unknown: "ask",
};

export interface PolicyContext {
  workingDir: string;
  /** Domains auto-allowed for egress (session allowlist ∪ global). */
  egressAllowlist: string[];
  /** Set for headless, run-to-completion sessions (deliverable/coordinated). Upgrades an
   * interpreter (python/node/`sh -c` …) from auto-allow to ASK, since a prompt-injected
   * unattended task can use an interpreter to write/exfiltrate without the operator in the
   * loop — the one path that bypasses the Signal gate. At the desk / interactive it stays allow. */
  unattended?: boolean;
}

export interface Evaluation {
  action: PolicyAction;
  decision: PolicyDecision;
  reason: string;
  detail: Record<string, unknown>;
}

// --- command lexicons (leading binary → category) --------------------------

const DELETE_CMDS = new Set(["rm", "rmdir", "unlink", "shred"]);
const DESTRUCTIVE_CMDS = new Set([
  "dd", "mkfs", "chmod", "chown", "chgrp", "ln", "truncate",
  "kill", "killall", "pkill", "sudo", "su", "mount", "umount", "diskutil",
]);
const NETWORK_CMDS = new Set([
  "curl", "wget", "nc", "ncat", "telnet", "ssh", "scp", "sftp", "ftp", "rsync",
]);
/** Build/test/format/dev tooling — routine, allowed within the working dir. */
const BUILD_CMDS = new Set([
  "npm", "npx", "yarn", "pnpm", "bun", "node", "deno",
  "make", "cmake", "cargo", "go", "rustc", "python", "python3", "pip", "pip3",
  "uv", "poetry", "ruby", "bundle", "tsc", "eslint", "prettier", "jest",
  "vitest", "pytest", "ruff", "black", "mypy", "gradle", "mvn",
]);
/** Read-only / inspection shell — allowed. */
const SAFE_CMDS = new Set([
  "ls", "cat", "echo", "pwd", "grep", "rg", "find", "head", "tail", "wc",
  "sort", "uniq", "awk", "sed", "diff", "file", "stat", "which", "type",
  "env", "printenv", "date", "true", "false", "test", "basename", "dirname",
  "realpath", "tree", "jq", "cut", "tr", "tee", "xargs", "less", "more",
]);
/** Consequential network even though they look routine — require approval. */
const CONSEQUENTIAL = new Set(["push", "publish"]); // git push, npm publish
/** File-creating/moving commands whose targets must follow the in/out-of-workdir rule
 * (dd is already destructive_shell). Their non-flag args are routed through pass-3. */
const WRITE_CMDS = new Set(["cp", "mv", "install", "ln"]);
/** Wrappers that exec another command — skipped to find the EFFECTIVE leader so a
 * wrapped `env python …` / `xargs python …` / `timeout 5 python …` is still recognized. */
const WRAPPER_CMDS = new Set([
  "env", "xargs", "timeout", "nice", "nohup", "stdbuf", "command", "sudo", "doas",
  "setsid", "ionice", "time", "watch",
]);

function pathUnder(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Resolve a tool's target path to its REAL filesystem location, following
 * symlinks in the deepest existing ancestor. A purely syntactic resolve would
 * let a symlink inside the working dir (e.g. workdir/escape → /etc/hosts) be
 * classified as an in-workdir write while the executor follows it outside the
 * dir — a containment escape (critical). Non-existent leaves (new files) keep
 * their syntactic path; only the existing prefix is realpath'd.
 */
function resolvePath(p: string, workingDir: string): string {
  const abs = isAbsolute(p) ? p : resolve(workingDir, p);
  const tail: string[] = [];
  let dir = abs;
  while (!existsSync(dir)) {
    const parent = dirname(dir);
    if (parent === dir) return abs; // hit root without an existing ancestor
    tail.unshift(basename(dir));
    dir = parent;
  }
  try {
    const real = realpathSync(dir);
    return tail.length ? resolve(real, ...tail) : real;
  } catch {
    return abs;
  }
}

/** Realpath the working dir too, so the comparison is symlink-consistent (e.g. macOS /tmp). */
function realDir(d: string): string {
  try {
    return existsSync(d) ? realpathSync(d) : resolve(d);
  } catch {
    return resolve(d);
  }
}

/** Extract candidate hostnames from a command/url for egress allowlisting. */
export function extractHosts(text: string): string[] {
  const hosts = new Set<string>();
  // Full URLs.
  for (const m of text.matchAll(/\bhttps?:\/\/([^/\s'"]+)/gi)) {
    const hostport = m[1];
    if (hostport) hosts.add(hostport.split("@").pop()!.split(":")[0]!.toLowerCase());
  }
  // scp/ssh style user@host: or bare host:path
  for (const m of text.matchAll(/(?:^|\s)([a-z0-9.-]+\.[a-z]{2,})(?::|\s|$)/gi)) {
    if (m[1]) hosts.add(m[1].toLowerCase());
  }
  return [...hosts];
}

function hostAllowed(host: string, allowlist: string[]): boolean {
  return allowlist.some((a) => {
    const d = a.toLowerCase().replace(/^\*\./, "");
    return host === d || host.endsWith("." + d);
  });
}

const RANK: Record<PolicyAction, number> = {
  read: 0, build_shell: 1, write_in_workdir: 1, interpreter_shell: 2, spawn_session: 3,
  write_outside_workdir: 3, change_sharing: 4, network_egress: 4,
  unknown: 4, destructive_shell: 5, delete: 5,
};

/** Split a shell line into sub-commands across ; && || | and a STANDALONE `&` (job
 * background / `a & b`) so each command is classified by its own leader. The `&`
 * split excludes redirect fd-dups (`2>&1`, `>&2`, `&>`) via the look-around: a `&`
 * adjacent to `>` or another `&` is not a separator. */
function splitSegments(cmd: string): string[] {
  return cmd
    .split(/(?:&&|\|\||;|\||(?<![>&])&(?![>&]))/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Map a command basename to its dangerous category, or null if not inherently dangerous. */
function dangerOfBasename(c: string): PolicyAction | null {
  if (DELETE_CMDS.has(c)) return "delete";
  if (c === "chmod" || c === "chown" || c === "chgrp") return "change_sharing";
  if (DESTRUCTIVE_CMDS.has(c)) return "destructive_shell";
  if (NETWORK_CMDS.has(c)) return "network_egress";
  return null;
}

function stripQuotes(s: string): string {
  return s.replace(/^["']|["']$/g, "");
}

/** Pseudo-files that are not a real filesystem write — a redirect here is benign. */
const BENIGN_WRITE_TARGETS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"]);

/** Quote-aware tokenizer (honors '…' and "…", strips the quotes). Good enough for
 * classification — not execution. */
function shellTokens(s: string): string[] {
  const toks: string[] = [];
  let cur = "";
  let has = false;
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (q) {
      if (c === q) q = null;
      else cur += c;
      has = true;
      continue;
    }
    if (c === "'" || c === '"') { q = c; has = true; continue; }
    if (/\s/.test(c)) { if (has) { toks.push(cur); cur = ""; has = false; } continue; }
    cur += c;
    has = true;
  }
  if (has) toks.push(cur);
  return toks;
}

/**
 * Quote-aware scan for shell redirection write targets. Handles ATTACHED redirects
 * (`cmd>f`), `>>`, `>|`, `&>`, and fd-prefixed (`2>f`); ignores `>` inside quotes and
 * `&fd` dups (`2>&1`). Regex-over-raw-text missed the attached/`>|` forms and matched
 * quoted `>` — this char scan fixes both. Returns target paths (quotes stripped).
 */
function redirectTargets(cmd: string): string[] {
  const targets: string[] = [];
  let q: string | null = null;
  let i = 0;
  const n = cmd.length;
  while (i < n) {
    const c = cmd[i]!;
    if (q) { if (c === q) q = null; i++; continue; }
    if (c === "'" || c === '"') { q = c; i++; continue; }
    if (c !== ">") { i++; continue; }
    i++; // consume '>'
    if (cmd[i] === ">") i++; // '>>'
    else if (cmd[i] === "|") i++; // '>|' (clobber)
    while (i < n && /\s/.test(cmd[i]!)) i++;
    let t = "";
    let tq: string | null = null;
    while (i < n) {
      const d = cmd[i]!;
      if (tq) { if (d === tq) tq = null; else t += d; i++; continue; }
      if (d === "'" || d === '"') { tq = d; i++; continue; }
      if (/\s/.test(d) || d === "|" || d === ";" || d === "&" || d === ">" || d === "<") break;
      t += d;
      i++;
    }
    if (t && !t.startsWith("&")) targets.push(t); // `&fd` is a descriptor dup, not a file
  }
  return targets;
}

/**
 * Raw paths a Bash line will CREATE or MODIFY beyond stdout: redirections (above),
 * `tee FILE…`, and `sed -i … FILE…` (ALL file operands, not just the last). Returned
 * unresolved; the caller routes each through the in/out-of-workdir rule so an
 * outside-dir write ASKS. Errs toward over-reporting (→ ask), never under — a missed
 * write would be the security hole.
 */
/** Short options (across env/xargs/timeout/nice/find) that consume the NEXT token as
 * their argument — so the argument isn't mistaken for the wrapped command. */
const WRAPPER_ARG_FLAGS = new Set(["u", "C", "a", "E", "L", "n", "P", "s", "d", "k", "p", "I"]);

/** Interpreters that run ARBITRARY code, version-suffix aware (python3.11, ruby3.0, …). */
function isInterpreter(c: string): boolean {
  return (
    /^(python|ruby|perl|php|node|deno|bun|lua|pwsh|powershell|rscript)[0-9._-]*$/.test(c) ||
    /^(bash|sh|zsh|dash|ksh|fish|osascript|tclsh|expect|groovy|scala)$/.test(c)
  );
}

/**
 * Classify the EFFECTIVE command basename at/after `start`, seeing THROUGH env-assignments
 * and wrapper commands (env/xargs/timeout/nice/…) and their option args. Returns "" when it
 * can't be cleanly resolved — `env -S`/`--split-string` (the arg IS the command), or a token
 * carrying shell expansion/escape/whitespace (`$(…)`, `\p\y…`, a quoted split). The caller
 * fails those CLOSED to `unknown` → ask, instead of trusting the SAFE wrapper leader.
 */
function effectiveCmd(toks: string[], start: number): string {
  let i = start;
  while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i]!)) i++; // env-assignments
  for (;;) {
    const word = toks[i];
    if (word === undefined) return "";
    const c = (word.split("/").pop() ?? "").toLowerCase();
    if (!WRAPPER_CMDS.has(c)) {
      if (/[$`\\]/.test(word) || /\s/.test(word)) return ""; // unresolvable → caller asks
      return c;
    }
    i++; // skip the wrapper word, then its flags / VAR=val / numeric args
    while (i < toks.length) {
      const t = toks[i]!;
      if (t === "-S" || t === "--split-string" || t.startsWith("-S") || t.startsWith("--split-string=")) return "";
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t) || /^\d+[a-z]?$/i.test(t)) { i++; continue; }
      if (t.startsWith("-")) {
        i++;
        if (WRAPPER_ARG_FLAGS.has(t.replace(/^-+/, "")) && i < toks.length && !toks[i]!.startsWith("-")) i++;
        continue;
      }
      break;
    }
  }
}

function bashWriteTargets(cmd: string): string[] {
  const targets = redirectTargets(cmd);
  for (const seg of splitSegments(cmd)) {
    const toks = shellTokens(seg);
    // Scan EVERY token for a `tee`/`sed` invocation — NOT just the segment leader —
    // because wrapper commands (xargs, env, find -exec, timeout, nice, …) are themselves
    // SAFE, so keying off the leader fail-OPENs a WRAPPED write (`xargs tee F`, `env tee F`,
    // `find . -exec sed -i … F {} +`). `tee` → following non-flag tokens are write targets;
    // `sed` with any in-place flag in the segment → its file operands are write targets.
    const sedInPlace = toks.some((t) => t === "-i" || t.startsWith("-i") || t.startsWith("--in-place"));
    for (let j = 0; j < toks.length; j++) {
      const base = (toks[j]!.split("/").pop() ?? "").toLowerCase();
      if (base === "tee" || WRITE_CMDS.has(base)) {
        // tee/cp/mv/install/ln: following non-flag tokens are write (or, for cp/mv, also
        // read) targets — routed through the in/out-of-workdir rule, so an in-workdir copy
        // stays allowed while a copy to /etc or ~ asks. Caught regardless of position, so a
        // wrapped `env cp x /etc/y` / `xargs cp {} /etc/y` is not hidden by the SAFE leader.
        for (let m = j + 1; m < toks.length; m++) if (!toks[m]!.startsWith("-")) targets.push(toks[m]!);
      } else if (base === "sed" && sedInPlace) {
        // operands after sed, skipping the first (the s/// script).
        const operands = toks.slice(j + 1).filter((t) => !t.startsWith("-"));
        for (const t of operands.slice(1)) targets.push(t);
      }
    }
  }
  return targets;
}

function classifyBash(cmd: string, ctx: PolicyContext): { action: PolicyAction; detail: Record<string, unknown> } {
  const detail: Record<string, unknown> = { command: cmd };
  const hosts = extractHosts(cmd);
  if (hosts.length) detail.hosts = hosts;
  // Egress only auto-allows when EVERY host in the line is allowlisted.
  const allHostsOk = hosts.length > 0 && hosts.every((h) => hostAllowed(h, ctx.egressAllowlist));

  let worst: PolicyAction = "read";
  const raise = (a: PolicyAction) => {
    const eff = a === "network_egress" && allHostsOk ? "build_shell" : a;
    if (RANK[eff] > RANK[worst]) worst = eff;
  };

  // Pass 1 — classify each segment by its EFFECTIVE command, seen THROUGH env-assignments
  // and wrappers (env/xargs/timeout/find -exec/…). Keying off the literal leader fail-OPENed
  // a wrapped command (`env python …`, `env <unknown> …`) to the SAFE wrapper's verdict;
  // resolving the effective command instead routes wrapped interpreters → interpreter_shell
  // and wrapped/unparseable commands → unknown (→ ask).
  const classifyLeader = (c: string) => {
    if (c === "") return raise("unknown"); // env -S / $(…) / escaped / bare wrapper → ask
    if (isInterpreter(c)) { detail.interpreter = true; return raise("interpreter_shell"); }
    const danger = dangerOfBasename(c);
    if (danger) return raise(danger);
    return undefined;
  };
  for (const seg of splitSegments(cmd)) {
    const toks = shellTokens(seg);
    const c = effectiveCmd(toks, 0);
    classifyLeader(c);
    if (c === "" || isInterpreter(c) || dangerOfBasename(c)) {
      // already classified above; only the build/safe/unknown tail differs
    } else if (c === "git" || BUILD_CMDS.has(c)) {
      const idx = toks.findIndex((t) => (t.split("/").pop() ?? "").toLowerCase() === c);
      const second = (toks[idx + 1] ?? "").toLowerCase();
      raise(CONSEQUENTIAL.has(second) ? "network_egress" : "build_shell");
    } else if (SAFE_CMDS.has(c) || WRITE_CMDS.has(c)) raise("read"); // cp/mv/… → pass 3 sets in/out
    else raise("unknown"); // unrecognized effective command → fail closed
    // `find -exec <cmd>` runs another command — classify it too (through wrappers).
    for (let j = 0; j < toks.length - 1; j++) {
      if (toks[j] === "-exec" || toks[j] === "-execdir") classifyLeader(effectiveCmd(toks, j + 1));
    }
  }

  // Command/process substitution EXECUTES its inner command — classify the command that
  // STARTS right after each `$(` / `<(` / `>(` / backtick opener, so an interpreter hidden
  // in `$(python3 -c "print(1)")` is gated. Opener-based (not balanced-paren matching) so
  // nested parens don't defeat it; only the substitution's leader is read, so a benign
  // `$(ls)` or an unrelated `grep python3 …` argument is not flagged.
  for (const m of cmd.matchAll(/\$\(|[<>]\(|`/g)) {
    classifyLeader(effectiveCmd(shellTokens(cmd.slice(m.index + m[0].length)), 0));
  }

  // Pass 2 — escalate on dangerous commands hidden anywhere: $(...), backticks,
  // quoting, or args. Tokenize on every non-command character. False positives
  // (e.g. the word "rm" in a commit message) fail safe to ask, never to allow.
  for (const t of cmd.split(/[^A-Za-z0-9._/-]+/)) {
    if (!t) continue;
    const danger = dangerOfBasename((t.split("/").pop() ?? "").toLowerCase());
    if (danger) raise(danger);
  }

  // Pass 3 — shell WRITES that masquerade as read-only (redirections, `tee FILE`,
  // `sed -i ... FILE`). Route each target through the same in/out-of-workdir rule as
  // Write/Edit so an outside-dir write ASKS (§5.5) instead of auto-allowing; an
  // unresolvable target (e.g. a `$VAR` path) fails safe to `ask`.
  const writes: string[] = [];
  for (const raw of bashWriteTargets(cmd)) {
    const t = stripQuotes(raw);
    if (!t || BENIGN_WRITE_TARGETS.has(t)) continue;
    if (t.startsWith("~") || /[\\$`{}()]/.test(t)) {
      // Can't be statically resolved to an in-workdir path, so fail safe to ask: `~`
      // expands to HOME; `\` is an escape (e.g. `\/etc` → `/etc`); `$VAR`/`` `…` `` are
      // substitutions; `{…}` is brace expansion; `(…)` is process substitution (`>(tee …)`).
      raise("write_outside_workdir");
      continue;
    }
    const p = resolvePath(t, ctx.workingDir);
    raise(pathUnder(p, realDir(ctx.workingDir)) ? "write_in_workdir" : "write_outside_workdir");
    writes.push(p);
  }
  if (writes.length) detail.writeTargets = writes;

  return { action: worst, detail };
}

export class PermissionPolicy {
  private readonly matrix: Record<PolicyAction, PolicyDecision>;

  constructor(
    overrides: Record<string, PolicyDecision> = {},
    private readonly globalEgress: string[] = [],
    /** Operator-confirmed auto-allow rules (Phase 6). Only upgrade `ask` → `allow`. */
    private readonly learnedRules: LearnedRule[] = [],
  ) {
    this.matrix = { ...DEFAULT_MATRIX };
    for (const [k, v] of Object.entries(overrides)) {
      if (k in this.matrix) this.matrix[k as PolicyAction] = v;
    }
  }

  /** A learned rule matching this action+target, if any (never relaxes allow/deny). */
  private matchLearned(action: PolicyAction, detail: Record<string, unknown>): LearnedRule | undefined {
    for (const r of this.learnedRules) {
      if (r.kind === "write" && action === "write_outside_workdir" && typeof detail.path === "string" && pathUnder(detail.path, r.scope)) {
        return r;
      }
      if (
        r.kind === "egress" &&
        action === "network_egress" &&
        Array.isArray(detail.hosts) &&
        (detail.hosts as string[]).length > 0 &&
        (detail.hosts as string[]).every((h) => hostAllowed(h, [r.scope]))
      ) {
        return r;
      }
    }
    return undefined;
  }

  private classify(toolName: string, input: unknown, ctx: PolicyContext): { action: PolicyAction; detail: Record<string, unknown> } {
    const i = (input ?? {}) as Record<string, unknown>;
    switch (toolName) {
      case "Read":
      case "Glob":
      case "Grep":
      case "NotebookRead":
        return { action: "read", detail: {} };

      case "Write":
      case "Edit":
      case "MultiEdit":
      case "NotebookEdit": {
        const raw = (i.file_path ?? i.notebook_path ?? i.path) as string | undefined;
        if (!raw) return { action: "unknown", detail: { toolName, reason: "no path" } };
        const p = resolvePath(raw, ctx.workingDir);
        return {
          action: pathUnder(p, realDir(ctx.workingDir)) ? "write_in_workdir" : "write_outside_workdir",
          detail: { path: p },
        };
      }

      case "Bash":
      case "BashOutput": {
        const command = (i.command as string | undefined) ?? "";
        if (!command) return { action: "read", detail: {} };
        return classifyBash(command, ctx);
      }

      case "WebFetch": {
        const url = (i.url as string | undefined) ?? "";
        const hosts = extractHosts(url);
        // ctx here is already merged with the global egress allowlist by evaluate().
        const ok = hosts.length > 0 && hosts.every((h) => hostAllowed(h, ctx.egressAllowlist));
        return { action: ok ? "read" : "network_egress", detail: { url, hosts } };
      }
      case "WebSearch":
        return { action: "network_egress", detail: { tool: "WebSearch" } };

      case "Task":
        return { action: "spawn_session", detail: { tool: "Task" } };

      default:
        return { action: "unknown", detail: { toolName } };
    }
  }

  evaluate(toolName: string, input: unknown, ctx: PolicyContext): Evaluation {
    const mergedCtx: PolicyContext = {
      workingDir: ctx.workingDir,
      egressAllowlist: [...ctx.egressAllowlist, ...this.globalEgress],
      unattended: ctx.unattended ?? false,
    };
    const { action, detail } = this.classify(toolName, input, mergedCtx);
    let decision = this.matrix[action];

    // An interpreter (arbitrary code) is auto-allowed at the desk / interactive, but a
    // headless UNATTENDED session upgrades it to ASK — the one path a prompt-injected
    // task could otherwise use to write/exfiltrate without the operator in the loop.
    if (action === "interpreter_shell" && mergedCtx.unattended) decision = "ask";

    // A confirmed learned rule can upgrade a would-be `ask` to `allow` for its
    // specific target — and only that direction (never relaxes allow→ or →deny).
    if (decision === "ask") {
      const learned = this.matchLearned(action, detail);
      if (learned) {
        return {
          action,
          decision: "allow",
          reason: `${toolName} → ${action} → allow (learned rule ${learned.id})`,
          detail: { toolName, ...detail, learnedRule: learned.id },
        };
      }
    }

    return {
      action,
      decision,
      reason: `${toolName} → ${action} → ${decision}`,
      detail: { toolName, ...detail },
    };
  }
}
