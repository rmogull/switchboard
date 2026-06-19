// Inc0 gate probe v2 — DIAGNOSTIC. v1 showed canUseTool fired 0 times while two
// `echo` tool_uses ran. Two hypotheses:
//   (b-benign)  the SDK auto-allows trivially-safe bash (echo) WITHOUT canUseTool,
//               so v1 used too-safe a command -> architecture fine.
//   (a-breaking) canUseTool never fires under streaming input -> architecture broken.
// This probe forces a CONSEQUENTIAL tool (Write) which should route to canUseTool,
// dumps the SDK init/permission message, and shows whether each tool actually ran.

import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "sw-probe2-"));
const target = join(scratch, "probe.txt");

const calls = [];
const canUseTool = async (toolName, input, _o) => {
  calls.push({ toolName, input });
  // Deny everything — we only care whether we are CONSULTED at all.
  return { behavior: "deny", message: "probe2: deny to observe gating" };
};

const userMsg = (text) => ({
  type: "user",
  message: { role: "user", content: text },
  parent_tool_use_id: null,
});

async function* inputStream() {
  yield userMsg(
    `Use the Write tool to create a file at ${target} containing the text "hello-probe". Do only that.`,
  );
}

const log = (...a) => console.log(...a);

const TIMEOUT_MS = 150_000;
const timeout = new Promise((_, rej) =>
  setTimeout(() => rej(new Error("timeout")), TIMEOUT_MS),
);

async function run() {
  const q = query({
    prompt: inputStream(),
    options: { cwd: scratch, canUseTool, permissionMode: "default", settingSources: [], maxTurns: 6 },
  });
  const seen = [];
  try {
    for await (const m of q) {
      seen.push(m.type);
      if (m.type === "system") {
        log("\n--- SYSTEM/init message (permission setup the SDK actually used) ---");
        log(JSON.stringify(m, null, 2).slice(0, 2500));
        log("--- end system message ---\n");
      }
      if (m.type === "assistant") {
        for (const b of m.message?.content ?? []) {
          if (b.type === "tool_use") log(`assistant tool_use: ${b.name} ${JSON.stringify(b.input).slice(0, 120)}`);
          if (b.type === "text" && b.text) log(`assistant text: ${b.text.slice(0, 200)}`);
        }
      }
      if (m.type === "user") {
        // tool_result comes back as a user message with tool_result content
        for (const b of m.message?.content ?? []) {
          if (b?.type === "tool_result") {
            const c = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
            log(`tool_result (is_error=${b.is_error}): ${String(c).slice(0, 200)}`);
          }
        }
      }
      if (m.type === "result") {
        log(`\nRESULT: subtype=${m.subtype ?? "?"} is_error=${m.is_error ?? "?"}`);
        log(`result text: ${String(m.result ?? "").slice(0, 300)}`);
        break;
      }
    }
  } finally {
    try { await q.interrupt?.(); } catch { /* noop */ }
  }
  return seen;
}

try {
  const seen = await Promise.race([run(), timeout]);
  log("\n================ Inc0 PROBE v2 (consequential Write) ================");
  log(`message types seen     : ${seen.join(", ")}`);
  log(`canUseTool invocations : ${calls.length}`);
  for (const c of calls) log(`   - ${c.toolName}: ${JSON.stringify(c.input).slice(0, 100)}`);
  log(`file actually written  : ${existsSync(target)}  (${target})`);
  log("--------------------------------------------------------------------");
  if (calls.length > 0) {
    log("FINDING: canUseTool IS consulted under streaming input for a consequential tool.");
    log("=> v1's 0 invocations were because `echo` is auto-allowed as trivially-safe.");
    log("=> The gate works under streaming; the architecture stands. PASS.");
  } else {
    log("FINDING: canUseTool was NOT consulted even for a Write under streaming input.");
    log(`=> file written = ${existsSync(target)}. If true, the tool ran UNGATED -> architecture-breaking.`);
    log("=> Gate FAILS; verdict reopens.");
  }
  log("====================================================================\n");
  process.exit(calls.length > 0 ? 0 : 1);
} catch (err) {
  console.error("PROBE v2 ERROR:", err?.stack || err);
  process.exit(2);
}
