/**
 * Phase 0 / Spike 1 — canUseTool async round-trip probe
 * ------------------------------------------------------
 * Proves the load-bearing assumption of the orchestrator design:
 * the Claude Agent SDK's canUseTool callback can AWAIT an out-of-band
 * decision (your Signal reply, here simulated by an HTTP call from another
 * terminal or your phone over Tailscale), and the SDK genuinely BLOCKS the
 * tool call until the decision resolves.
 *
 * It runs two passes against a real `query()`:
 *   1. allow path  -> you approve  -> the file SHOULD be created
 *   2. deny path   -> you reject   -> the file should NOT be created
 *
 * PASS means: the callback fired, the SDK waited for your out-of-band reply,
 * and allow/deny were each honored (action happened / was blocked).
 *
 * Run on YOUR Mac, authenticated to your Max plan via the official CLI/SDK.
 *   npm install && npm run probe
 * Then, when it prints a pending decision, hit the printed curl from a second
 * terminal (or from your phone on the tailnet) to approve or deny.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import http from "node:http";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";

type Behavior = "allow" | "deny";
type Pending = {
  id: string;
  toolName: string;
  input: unknown;
  firedAt: number;
  resolve: (behavior: Behavior) => void;
};

const PORT = Number(process.env.PROBE_PORT ?? 8787);
const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS ?? 120_000);
const SCRATCH = process.env.PROBE_SCRATCH ?? "/tmp/canusetool_probe";
const ALLOW_TARGET = `${SCRATCH}/allow_proof.txt`;
const DENY_TARGET = `${SCRATCH}/deny_proof.txt`;

const pending = new Map<string, Pending>();

// --- out-of-band decision server (stands in for the Signal command channel) ---
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  if (url.pathname === "/pending") {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify(
        [...pending.values()].map((p) => ({
          id: p.id,
          toolName: p.toolName,
          input: p.input,
          waitingMs: Date.now() - p.firedAt,
        })),
      ),
    );
    return;
  }
  if (url.pathname === "/decide") {
    const id = url.searchParams.get("id") ?? "";
    const behavior = url.searchParams.get("behavior");
    const p = pending.get(id);
    if (!p || (behavior !== "allow" && behavior !== "deny")) {
      res.statusCode = 400;
      res.end('bad request: need ?id=<id>&behavior=allow|deny\n');
      return;
    }
    pending.delete(id);
    p.resolve(behavior);
    res.end(`recorded ${behavior} for ${id}\n`);
    return;
  }
  res.statusCode = 404;
  res.end("not found\n");
});

function externalDecision(toolName: string, input: unknown): Promise<Behavior> {
  const id = randomUUID().slice(0, 8);
  const firedAt = Date.now();
  console.log(`\n[canUseTool] FIRED  tool="${toolName}"  id=${id}`);
  console.log(`[canUseTool] input : ${JSON.stringify(input)}`);
  console.log(`[canUseTool] AWAITING an out-of-band decision. From a second terminal (or your phone over Tailscale) run ONE of:`);
  console.log(`    curl "http://localhost:${PORT}/decide?id=${id}&behavior=allow"`);
  console.log(`    curl "http://localhost:${PORT}/decide?id=${id}&behavior=deny"`);
  console.log(`[canUseTool] (auto-deny in ${TIMEOUT_MS / 1000}s if no reply)\n`);
  return new Promise<Behavior>((resolve) => {
    const timer = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        console.log(`[canUseTool] id=${id} TIMED OUT -> deny`);
        resolve("deny");
      }
    }, TIMEOUT_MS);
    pending.set(id, {
      id,
      toolName,
      input,
      firedAt,
      resolve: (behavior) => {
        clearTimeout(timer);
        resolve(behavior);
      },
    });
  });
}

async function run(label: string, target: string, expected: Behavior): Promise<boolean> {
  console.log(`\n=== RUN: ${label} (intend to ${expected}) -> ${target} ===`);
  if (existsSync(target)) rmSync(target);

  let firedFor = "";
  let firedAt = 0;
  let resolvedAt = 0;
  let returned: string = "none";

  const response = query({
    prompt:
      `Use the Bash tool to create a file at ${target} containing exactly the text PROVE_IT. ` +
      `Use only the Bash tool. Do not read or write anything else.`,
    options: {
      permissionMode: "default",
      // Deliberately do NOT pre-approve Bash, so the call falls through to canUseTool.
      allowedTools: ["Read"],
      canUseTool: async (toolName, input) => {
        firedFor = toolName;
        firedAt = Date.now();
        const decision = await externalDecision(toolName, input);
        resolvedAt = Date.now();
        returned = decision;
        if (decision === "allow") {
          return { behavior: "allow", updatedInput: input };
        }
        return { behavior: "deny", message: "denied by probe operator" };
      },
    },
  });

  for await (const _msg of response) {
    // drain the agent stream to completion
  }

  const blockedMs = firedAt && resolvedAt ? resolvedAt - firedAt : 0;
  const created = existsSync(target);
  const pass =
    firedFor !== "" &&
    returned === expected &&
    ((expected === "allow" && created) || (expected === "deny" && !created));

  console.log(`\n--- RESULT: ${label} ---`);
  console.log(`callback fired for tool : ${firedFor || "(NEVER FIRED)"}`);
  console.log(`SDK blocked for         : ${blockedMs} ms  (>0 proves it awaited the out-of-band reply)`);
  console.log(`decision returned       : ${returned}`);
  console.log(`target file created     : ${created}`);
  console.log(`PASS                    : ${pass}`);
  return pass;
}

async function main() {
  mkdirSync(SCRATCH, { recursive: true });
  await new Promise<void>((r) =>
    server.listen(PORT, () => {
      console.log(`decision server: http://localhost:${PORT}  (GET /pending ; GET /decide?id=..&behavior=allow|deny)`);
      r();
    }),
  );

  const allowPass = await run("allow path", ALLOW_TARGET, "allow");
  const denyPass = await run("deny path", DENY_TARGET, "deny");

  console.log(`\n================ SPIKE 1 SUMMARY ================`);
  console.log(`allow round-trip honored : ${allowPass}`);
  console.log(`deny round-trip honored  : ${denyPass}`);
  console.log(
    `OVERALL                  : ${
      allowPass && denyPass
        ? "PASS - Signal-style async approval is viable"
        : "FAIL - rethink the approval channel (see notes)"
    }`,
  );
  server.close();
  process.exit(allowPass && denyPass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
