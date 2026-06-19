import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { SwitchboardError } from "../core/errors.js";
import { isPathUnder } from "../core/paths.js";
import type { ProposalCategory } from "../state/types.js";

/** Default markdown file per proposal category, under <home>/memory/. */
const DEFAULT_FILE: Record<ProposalCategory, string> = {
  feedback: "learnings.md",
  task_pattern: "task-patterns.md",
  convention: "conventions/general.md",
  policy_candidate: "policy-candidates.md",
};

/**
 * The curated learning memory (§5.6) — markdown under `<home>/memory/`,
 * git-tracked so promotions are diffable. This layer only ever writes; it never
 * interprets memory as instruction. Child-supplied target paths are tainted
 * (Invariant 2), so resolveFile contains them strictly under the memory dir.
 */
export class MemoryStore {
  private readonly memDir: string;

  constructor(homeDir: string) {
    this.memDir = join(homeDir, "memory");
  }

  get dir(): string {
    return this.memDir;
  }

  /**
   * Resolve the markdown file for a promotion. A child-proposed `targetFile` is
   * accepted only if it stays under the memory dir and ends in `.md` — traversal
   * (`../`), absolute paths, and non-markdown targets are rejected.
   */
  resolveFile(category: ProposalCategory, targetFile?: string | null): string {
    if (targetFile) {
      const cleaned = targetFile.replace(/^[/\\]+/, "");
      const abs = resolve(this.memDir, cleaned);
      if (!isPathUnder(abs, this.memDir)) {
        throw new SwitchboardError("memory_path", `proposed memory file escapes the memory dir: ${targetFile}`);
      }
      if (!abs.endsWith(".md")) {
        throw new SwitchboardError("memory_path", `memory files must be .md: ${targetFile}`);
      }
      return abs;
    }
    return join(this.memDir, DEFAULT_FILE[category]);
  }

  /** Append a promotion as a provenance-stamped markdown block. */
  appendEntry(file: string, text: string, prov: { sessionId: string; iso: string }): void {
    mkdirSync(dirname(file), { recursive: true });
    const block = `\n## ${prov.iso} — promoted from session ${prov.sessionId}\n\n${text.trim()}\n`;
    appendFileSync(file, block);
  }

  read(relPath: string): string {
    const abs = resolve(this.memDir, relPath.replace(/^[/\\]+/, ""));
    if (!isPathUnder(abs, this.memDir) || !existsSync(abs)) return "";
    return readFileSync(abs, "utf8");
  }

  /** All markdown files currently in the memory tree (relative paths). */
  listFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string, prefix: string) => {
      if (!existsSync(dir)) return;
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) walk(join(dir, e.name), rel);
        else if (e.name.endsWith(".md")) out.push(rel);
      }
    };
    walk(this.memDir, "");
    return out.sort();
  }

  /**
   * Concatenate the learned context the dispatcher injects at task start (§7.1).
   * Always read as DATA. Bounded so a large memory can't blow the prompt budget.
   */
  readContext(repo?: string, maxBytes = 20_000): string {
    const files = ["learnings.md", "task-patterns.md", ...(repo ? [`conventions/${repo}.md`] : [])];
    const parts: string[] = [];
    let total = 0;
    for (const f of files) {
      const body = this.read(f).trim();
      if (!body) continue;
      const chunk = `# ${f}\n${body}`;
      total += chunk.length;
      if (total > maxBytes) break;
      parts.push(chunk);
    }
    return parts.join("\n\n");
  }
}
