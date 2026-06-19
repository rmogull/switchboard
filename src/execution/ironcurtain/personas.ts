/**
 * Enumerate the hand-authored IronCurtain personas installed under the personas
 * root (default `~/.ironcurtain/personas`). A persona is OFFERED only when it is
 * fully PRE-COMPILED — it has both `persona.json` and `generated/compiled-policy.json`
 * — so Switchboard never hands a name to IronCurtain that would trip the API-key
 * LLM compiler at runtime (the "keep the model out of the runtime policy path"
 * rule). The list is the allowlist the Signal/dashboard/CLI trigger surfaces
 * validate a requested persona against, so an arbitrary name can never be injected
 * into a `sessions.create`.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { expandHome } from "../../core/paths.js";

export interface IcPersona {
  readonly name: string;
  readonly description?: string;
  readonly servers?: string[];
  readonly memory?: boolean;
}

export function listIronCurtainPersonas(personasDir: string): IcPersona[] {
  const root = expandHome(personasDir);
  let names: string[];
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return []; // personas root absent (backend not installed yet) — no personas offered
  }

  const out: IcPersona[] = [];
  for (const name of names) {
    const dir = join(root, name);
    // Both files are mandatory: persona.json declares servers/memory; the compiled
    // policy is the no-LLM-needed runtime contract. Missing either ⇒ skip silently.
    if (!existsSync(join(dir, "persona.json"))) continue;
    if (!existsSync(join(dir, "generated", "compiled-policy.json"))) continue;

    const persona: { name: string; description?: string; servers?: string[]; memory?: boolean } = { name };
    try {
      const p = JSON.parse(readFileSync(join(dir, "persona.json"), "utf-8")) as {
        description?: unknown;
        servers?: unknown;
        memory?: { enabled?: unknown };
      };
      if (typeof p.description === "string") persona.description = p.description;
      if (Array.isArray(p.servers)) persona.servers = p.servers.filter((s): s is string => typeof s === "string");
      if (p.memory && typeof p.memory.enabled === "boolean") persona.memory = p.memory.enabled;
    } catch {
      /* unreadable persona.json — still list by directory name (it is pre-compiled) */
    }
    out.push(persona);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** True if `name` is an installed, pre-compiled persona (the trigger-surface allowlist check). */
export function isKnownPersona(personasDir: string, name: string): boolean {
  return listIronCurtainPersonas(personasDir).some((p) => p.name === name);
}
