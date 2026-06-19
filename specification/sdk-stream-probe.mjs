// Inc0 gate probe — verify the load-bearing assumption behind the SDK-streaming
// Signal-driver re-architecture: that with prompt = AsyncIterable<SDKUserMessage>
// (streaming input mode), the gated permission spine still fully applies.
//
// Asserts THREE things in one run:
//  (1) canUseTool FIRES on a tool-use when input is a stream (the kill-switch).
//  (2) settingSources:[] isolation HOLDS under streaming — Bash is in the user's
//      ambient ~/.claude allow-list, so if isolation leaked, the pre-approved Bash
//      would skip canUseTool and the recorder would show zero invocations.
//  (3) A SECOND streamed user turn drives another assistant turn (multi-turn
//      steering — the premise of the bidirectional design).
//
// Run: node specification/sdk-stream-probe.mjs
// Exit 0 = PASS (gate green), non-zero = FAIL (verdict reopens).

import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "sw-probe-"));
const MARK1 = "SWITCHBOARD_PROBE_OK";
const MARK2 = "SWITCHBOARD_PROBE_TURN2";

const calls = []; // every canUseTool invocation
let denied = 0;

const canUseTool = async (toolName, input, _options) => {
  calls.push({ toolName, input });
  const cmd = typeof input?.command === "string" ? input.command : "";
  // Allow ONLY the two exact safe echo commands this probe asks for; deny anything else.
  if (toolName === "Bash" && (cmd.includes(MARK1) || cmd.includes(MARK2))) {
    return { behavior: "allow", updatedInput: input };
  }
  denied++;
  return { behavior: "deny", message: "probe: only the exact echo is allowed" };
};

const userMsg = (text) => ({
  type: "user",
  message: { role: "user", content: text },
  parent_tool_use_id: null,
});

let releaseTurn2;
const turn2Gate = new Promise((res) => (releaseTurn2 = res));

async function* inputStream() {
  yield userMsg(
    `Use the Bash tool to run exactly this command and nothing else: echo ${MARK1}`,
  );
  await turn2Gate; // suspend until the first result lands — proves the stream stays open
  yield userMsg(
    `Now use the Bash tool to run exactly this command and nothing else: echo ${MARK2}`,
  );
}

async function run() {
  const q = query({
    prompt: inputStream(),
    options: {
      cwd: scratch,
      canUseTool,
      permissionMode: "default", // the gated default — not acceptEdits/bypass
      settingSources: [], // the load-bearing isolation under test
      maxTurns: 12,
    },
  });

  let results = 0;
  const toolUses = [];
  const assistantText = [];

  try {
    for await (const m of q) {
      if (m.type === "assistant") {
        for (const b of m.message?.content ?? []) {
          if (b.type === "text" && b.text) assistantText.push(b.text);
          if (b.type === "tool_use") toolUses.push({ name: b.name, input: b.input });
        }
      }
      if (m.type === "result") {
        results++;
        if (results === 1) releaseTurn2();
        if (results >= 2) break;
      }
    }
  } finally {
    try {
      await q.interrupt?.();
    } catch {
      /* best-effort cleanup */
    }
  }

  return { results, toolUses };
}

const TIMEOUT_MS = 180_000;
const timeout = new Promise((_, rej) =>
  setTimeout(() => rej(new Error(`probe timed out after ${TIMEOUT_MS}ms`)), TIMEOUT_MS),
);

try {
  const { results, toolUses } = await Promise.race([run(), timeout]);

  const bashCalls = calls.filter((c) => c.toolName === "Bash");
  const cond1 = calls.length > 0; // canUseTool fired at all
  const cond2 = bashCalls.length > 0; // it fired for Bash (ambient allow-list did NOT bypass it)
  const cond3 = results >= 2; // second streamed turn drove another assistant turn

  console.log("\n================ Inc0 SDK STREAMING GATE PROBE ================");
  console.log(`canUseTool invocations : ${calls.length}`);
  for (const c of calls) {
    const cmd = typeof c.input?.command === "string" ? c.input.command : JSON.stringify(c.input);
    console.log(`   - ${c.toolName}: ${String(cmd).slice(0, 80)}`);
  }
  console.log(`denied (non-echo)      : ${denied}`);
  console.log(`tool_use blocks seen   : ${toolUses.length}`);
  console.log(`result messages        : ${results}`);
  console.log("----------------------------------------------------------------");
  console.log(`(1) canUseTool fires under streaming input ............ ${cond1 ? "PASS" : "FAIL"}`);
  console.log(`(2) settingSources:[] isolation holds (Bash gated) .... ${cond2 ? "PASS" : "FAIL"}`);
  console.log(`(3) multi-turn streaming steering works .............. ${cond3 ? "PASS" : "FAIL"}`);
  console.log("================================================================");

  const ok = cond1 && cond2 && cond3;
  console.log(ok ? "VERDICT: PASS — Inc1 is green-lit.\n" : "VERDICT: FAIL — gate did not pass; verdict reopens.\n");
  process.exit(ok ? 0 : 1);
} catch (err) {
  console.error("\nPROBE ERROR:", err?.stack || err);
  console.error("VERDICT: INCONCLUSIVE — could not complete the probe.\n");
  process.exit(2);
}
