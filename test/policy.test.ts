import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PermissionPolicy, type PolicyContext } from "../src/permissions/policy.js";

const WD = "/work/proj";
const ctx: PolicyContext = { workingDir: WD, egressAllowlist: [] };
const ctxAllow = (...domains: string[]): PolicyContext => ({ workingDir: WD, egressAllowlist: domains });

const policy = new PermissionPolicy();
const ev = (tool: string, input: unknown, c: PolicyContext = ctx) => policy.evaluate(tool, input, c);

describe("policy — reads", () => {
  it("allows reads regardless of path (low consequence)", () => {
    expect(ev("Read", { file_path: "/etc/passwd" }).decision).toBe("allow");
    expect(ev("Glob", { pattern: "**/*" }).decision).toBe("allow");
    expect(ev("Grep", { pattern: "x" }).decision).toBe("allow");
  });
});

describe("policy — writes", () => {
  it("allows writes inside the working dir", () => {
    expect(ev("Write", { file_path: `${WD}/a.ts` }).decision).toBe("allow");
    expect(ev("Write", { file_path: `${WD}/sub/a.ts` }).decision).toBe("allow");
    expect(ev("Edit", { file_path: `${WD}/x` }).decision).toBe("allow");
  });
  it("resolves relative paths against the working dir", () => {
    expect(ev("Write", { file_path: "a.ts" }).action).toBe("write_in_workdir");
  });
  it("asks for writes outside the working dir", () => {
    expect(ev("Write", { file_path: "/etc/hosts" }).decision).toBe("ask");
    expect(ev("Write", { file_path: "../outside.ts" }).decision).toBe("ask");
  });
  it("is not fooled by a sibling dir that shares a prefix", () => {
    const e = ev("Write", { file_path: "/work/projevil/x" });
    expect(e.action).toBe("write_outside_workdir");
    expect(e.decision).toBe("ask");
  });
  it("asks when a write has no resolvable path", () => {
    expect(ev("Write", {}).action).toBe("unknown");
    expect(ev("Write", {}).decision).toBe("ask");
  });
});

describe("policy — bash baseline", () => {
  it("allows inspection and build/test commands", () => {
    for (const command of ["ls -la", "cat f", "cat f | grep x", "npm test", "npm install", "git status", "git commit -m wip", "tsc --noEmit", "make build"]) {
      expect(ev("Bash", { command }).decision, command).toBe("allow");
    }
  });
  it("asks on delete, destructive, and sharing-change commands", () => {
    expect(ev("Bash", { command: "rm -rf build" }).action).toBe("delete");
    expect(ev("Bash", { command: "chmod 777 x" }).action).toBe("change_sharing");
    expect(ev("Bash", { command: "dd if=/dev/zero of=/x" }).action).toBe("destructive_shell");
    for (const command of ["rm -rf build", "chmod 777 x", "kill -9 123", "sudo ls"]) {
      expect(ev("Bash", { command }).decision, command).toBe("ask");
    }
  });
  it("asks on consequential network (git push, npm publish)", () => {
    expect(ev("Bash", { command: "git push origin main" }).action).toBe("network_egress");
    expect(ev("Bash", { command: "npm publish" }).action).toBe("network_egress");
  });
  it("fails closed on an unrecognized leading binary", () => {
    expect(ev("Bash", { command: "weirdtool --do-thing" }).action).toBe("unknown");
    expect(ev("Bash", { command: "weirdtool --do-thing" }).decision).toBe("ask");
  });
});

describe("policy — bash bypass hardening", () => {
  it("catches a delete hidden in command substitution", () => {
    expect(ev("Bash", { command: "echo $(rm -rf /)" }).action).toBe("delete");
    expect(ev("Bash", { command: "echo `rm -rf x`" }).action).toBe("delete");
  });
  it("skips env-var prefixes to find the real command", () => {
    expect(ev("Bash", { command: "FOO=bar rm x" }).action).toBe("delete");
  });
  it("takes the worst action across a compound command", () => {
    expect(ev("Bash", { command: "echo hi && rm x" }).action).toBe("delete");
    expect(ev("Bash", { command: "npm run build && curl https://cdn.evil.com" }).action).toBe("network_egress");
  });
});

describe("policy — bash writes outside workdir → ask (tee / sed -i / redirection)", () => {
  const a = (command: string) => ev("Bash", { command });
  it("asks when tee writes outside the working dir", () => {
    expect(a("echo x | tee /etc/outside.txt").action).toBe("write_outside_workdir");
    expect(a("echo x | tee /etc/outside.txt").decision).toBe("ask");
  });
  it("allows tee into the working dir (incl. append)", () => {
    expect(a("echo x | tee out.txt").decision).toBe("allow");
    expect(a("echo a | tee -a logs/app.log").decision).toBe("allow");
  });
  it("asks when sed -i edits a file outside the working dir", () => {
    expect(a("sed -i 's/a/b/' /etc/hosts").action).toBe("write_outside_workdir");
  });
  it("allows sed -i on a file inside the working dir, and plain sed (read-only)", () => {
    expect(a("sed -i 's/a/b/' src/app.ts").decision).toBe("allow");
    expect(a("sed 's/a/b/' src/app.ts").decision).toBe("allow");
  });
  it("asks for a redirection that writes outside the working dir", () => {
    expect(a("echo hi > /etc/x").action).toBe("write_outside_workdir");
    expect(a("echo hi >> /var/log/x").action).toBe("write_outside_workdir");
  });
  it("allows a redirection inside the working dir", () => {
    expect(a("echo hi > out.txt").decision).toBe("allow");
  });
  it("ignores /dev/null and fd dups (2>&1) — not real filesystem writes", () => {
    expect(a("echo hi > /dev/null").decision).toBe("allow");
    expect(a("npm test 2>&1").decision).toBe("allow");
  });
  it("fails safe to ask for an unresolvable ($VAR) write target", () => {
    expect(a("cat f > $HOME/x").action).toBe("write_outside_workdir");
  });
  it("catches attached and clobber/&> redirections (no space, >|, &>) — all ask", () => {
    // `>|` gets split on the pipe and the target reads as an unknown command; either
    // way the security guarantee is the same: an outside-dir write must ASK.
    expect(a("echo hi>/etc/x").decision).toBe("ask");
    expect(a("echo hi >| /etc/x").decision).toBe("ask");
    expect(a("echo hi &> /etc/x").decision).toBe("ask");
    expect(a("echo hi>/etc/x").action).toBe("write_outside_workdir");
  });
  it("catches ALL sed -i operands, not just the last", () => {
    expect(a("sed -i s/a/b/ /etc/hosts src/app.ts").action).toBe("write_outside_workdir");
  });
  it("catches every tee file arg", () => {
    expect(a("echo x | tee a.txt /etc/c").action).toBe("write_outside_workdir");
  });
  it("does NOT treat a quoted > as a redirection (no false ask)", () => {
    expect(a('echo "literal > /etc/x"').decision).toBe("allow");
  });
  it("catches WRAPPED tee/sed writes (xargs/env/find -exec) — the fail-open blocker", () => {
    expect(a("ls | xargs -I{} tee /etc/x").decision).toBe("ask");
    expect(a("echo f | xargs sed -i s/a/b/ /etc/hosts").decision).toBe("ask");
    expect(a("env tee /etc/cron.d/pwn").decision).toBe("ask");
    expect(a("find . -exec sed -i s/a/b/ /etc/hosts {} +").decision).toBe("ask");
  });
  it("treats ~ (HOME) write targets as outside the workdir", () => {
    expect(a("tee ~/.ssh/authorized_keys").decision).toBe("ask");
    expect(a("echo x >> ~/.zshrc").decision).toBe("ask");
  });
  it("catches wrapped cp/mv/install/ln writes outside the workdir", () => {
    expect(a("env cp package.json /tmp/leak").decision).toBe("ask");
    expect(a("echo p | xargs -I{} cp {} /tmp/leak").decision).toBe("ask");
    expect(a("find . -exec install -m 600 p /tmp/leak ;").decision).toBe("ask");
    expect(a("ln -s /etc/x link").decision).toBe("ask");
    expect(a("echo hi & cp p /tmp/leak").decision).toBe("ask"); // & doesn't hide it
  });
  it("allows an in-workdir copy (cp/mv targets inside the workdir) when wrapped", () => {
    expect(a("env cp a.ts src/b.ts").decision).toBe("allow");
  });
  it("fails safe to ask on escape / brace / process-substitution write targets", () => {
    expect(a("echo x > \\/tmp/leak").decision).toBe("ask"); // \/tmp unescapes to /tmp
    expect(a("echo x | tee {/tmp/a,/tmp/b}").decision).toBe("ask"); // brace expansion
    expect(a("echo x > >(tee /tmp/leak)").decision).toBe("ask"); // process substitution
  });
  it("does not break 2>&1 (the & is a fd-dup, not a separator)", () => {
    expect(a("npm test 2>&1").decision).toBe("allow");
  });
});

describe("policy — interpreters gated only when unattended", () => {
  const ctxUn: PolicyContext = { workingDir: WD, egressAllowlist: [], unattended: true };
  const un = (command: string) => policy.evaluate("Bash", { command }, ctxUn);
  const INTERP = ["python -c x", "python3 s.py", "node -e 1", "ruby -e 1", "deno run x", "bun run x"];
  it("auto-allows interpreters at the desk / interactive (no unattended flag)", () => {
    for (const c of INTERP) expect(ev("Bash", { command: c }).decision, c).toBe("allow");
  });
  it("asks for interpreters in an unattended session", () => {
    for (const c of INTERP) {
      expect(un(c).action, c).toBe("interpreter_shell");
      expect(un(c).decision, c).toBe("ask");
    }
  });
  it("sees through wrappers (env / xargs / timeout / find -exec)", () => {
    for (const c of ["env python s.py", "echo x | xargs python", "timeout 5 python -c x", "find . -exec python -c x {} +", "env FOO=1 python -c x"]) {
      expect(un(c).decision, c).toBe("ask");
    }
  });
  it("does NOT flag an interpreter name appearing as an argument, not a command", () => {
    for (const c of ["which python", "echo python", "ls python", "cat python.txt", "npm test", "make build"]) {
      expect(un(c).decision, c).toBe("allow");
    }
  });
  it("lets a worse action win over the interpreter flag", () => {
    expect(un("python -c x && rm -rf y").action).toBe("delete");
    expect(un("python -c x > /etc/passwd").action).toBe("write_outside_workdir");
  });
  it("sees through &-separators and command/process substitution", () => {
    for (const c of ['echo ok & python3 -c x', 'echo $(python3 -c "print(1)")', "echo `python3 -c x`", "cat <(python3 -c x)"]) {
      expect(un(c).decision, c).toBe("ask");
    }
    expect(un("npm test 2>&1").decision).toBe("allow"); // 2>&1 not mistaken for a separator
    expect(un("grep python3 $(ls)").decision).toBe("allow"); // python3 is an arg, not the sub's leader
  });
  it("fails closed through wrappers (version suffix, env -S, $(which …))", () => {
    for (const c of ["env python3.11 -c x", "env -S 'python3 -c x'", "env $(which python3) -c x", "ruby3.0 -e 1"]) {
      expect(un(c).decision, c).toBe("ask");
    }
  });
});

describe("policy — egress allowlist", () => {
  it("asks for egress to non-allowlisted hosts", () => {
    expect(ev("Bash", { command: "curl https://evil.com" }).action).toBe("network_egress");
    expect(ev("WebFetch", { url: "https://docs.python.org/3/" }).decision).toBe("ask");
    expect(ev("WebSearch", {}).decision).toBe("ask");
  });
  it("allows egress to allowlisted hosts (incl. subdomains)", () => {
    expect(ev("Bash", { command: "curl https://api.github.com/x" }, ctxAllow("github.com")).decision).toBe("allow");
    expect(ev("WebFetch", { url: "https://docs.python.org/3/" }, ctxAllow("python.org")).decision).toBe("allow");
  });
  it("rejects a suffix-spoofed host", () => {
    expect(ev("WebFetch", { url: "https://example.com.evil.com" }, ctxAllow("example.com")).decision).toBe("ask");
    expect(ev("Bash", { command: "curl https://evilexample.com" }, ctxAllow("example.com")).decision).toBe("ask");
  });
});

describe("policy — spawn + unknown tools", () => {
  it("asks before a session spawns another (Task)", () => {
    expect(ev("Task", { prompt: "x" }).action).toBe("spawn_session");
    expect(ev("Task", { prompt: "x" }).decision).toBe("ask");
  });
  it("asks for any unrecognized tool (fail closed)", () => {
    expect(ev("SomeMcpTool", { a: 1 }).action).toBe("unknown");
    expect(ev("SomeMcpTool", { a: 1 }).decision).toBe("ask");
  });
});

describe("policy — overrides + global egress", () => {
  it("honors matrix overrides", () => {
    const p = new PermissionPolicy({ write_outside_workdir: "allow", read: "ask" });
    expect(p.evaluate("Write", { file_path: "/etc/x" }, ctx).decision).toBe("allow");
    expect(p.evaluate("Read", { file_path: "/x" }, ctx).decision).toBe("ask");
  });
  it("applies a global egress allowlist from the constructor", () => {
    const p = new PermissionPolicy({}, ["internal.corp"]);
    expect(p.evaluate("Bash", { command: "curl https://internal.corp/x" }, ctx).decision).toBe("allow");
  });
});

describe("policy — symlink write containment (critical regression)", () => {
  it("treats a write through an in-workdir symlink that escapes as OUTSIDE the workdir", () => {
    const wd = mkdtempSync(join(tmpdir(), "sw-wd-"));
    const outside = mkdtempSync(join(tmpdir(), "sw-out-"));
    const outsideFile = join(outside, "target.txt");
    writeFileSync(outsideFile, "x");
    symlinkSync(outsideFile, join(wd, "escape")); // wd/escape -> outside/target.txt
    const e = policy.evaluate("Write", { file_path: join(wd, "escape"), content: "evil" }, { workingDir: wd, egressAllowlist: [] });
    expect(e.action).toBe("write_outside_workdir");
    expect(e.decision).toBe("ask");
  });

  it("treats a write into a symlinked subdirectory that escapes as OUTSIDE", () => {
    const wd = mkdtempSync(join(tmpdir(), "sw-wd-"));
    const outside = mkdtempSync(join(tmpdir(), "sw-out-"));
    symlinkSync(outside, join(wd, "linkdir")); // wd/linkdir -> outside/
    const e = policy.evaluate("Write", { file_path: join(wd, "linkdir", "new.txt"), content: "evil" }, { workingDir: wd, egressAllowlist: [] });
    expect(e.action).toBe("write_outside_workdir");
  });

  it("still allows a genuine new file inside the real working dir", () => {
    const wd = mkdtempSync(join(tmpdir(), "sw-wd-"));
    mkdirSync(join(wd, "sub"));
    const e = policy.evaluate("Write", { file_path: join(wd, "sub", "new.ts"), content: "ok" }, { workingDir: wd, egressAllowlist: [] });
    expect(e.action).toBe("write_in_workdir");
    expect(e.decision).toBe("allow");
  });
});
