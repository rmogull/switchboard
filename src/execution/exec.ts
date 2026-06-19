import { spawn } from "node:child_process";

import { SwitchboardError } from "../core/errors.js";

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Written to the child's stdin, which is then closed. */
  input?: string;
}

/**
 * Run a binary to completion, capturing stdout/stderr. This is how Switchboard
 * drives the official CLIs and tmux as subprocesses (Invariant 1). It never uses
 * a shell, so arguments are passed as an array and are not subject to shell
 * interpretation — tainted task content can't smuggle in shell metacharacters.
 */
export function run(
  file: string,
  args: string[],
  opts: RunOptions = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: opts.cwd ?? process.cwd(),
      env: opts.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timer: ReturnType<typeof setTimeout> | undefined;

    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(
          new SwitchboardError(
            "exec_timeout",
            `timed out after ${opts.timeoutMs}ms: ${file} ${args.join(" ")}`,
          ),
        );
      }, opts.timeoutMs);
    }

    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });

    child.stdin.end(opts.input ?? "");
  });
}

/** Run and throw a SwitchboardError unless the process exits 0. */
export async function runOk(
  file: string,
  args: string[],
  opts: RunOptions = {},
): Promise<RunResult> {
  const r = await run(file, args, opts);
  if (r.code !== 0) {
    throw new SwitchboardError(
      "exec_failed",
      `${file} ${args.join(" ")} exited ${r.code}: ${r.stderr.trim() || r.stdout.trim()}`,
    );
  }
  return r;
}
