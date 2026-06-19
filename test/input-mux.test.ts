import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";

import { mergedInput } from "../src/execution/input-mux.js";
import type { SteeringRow } from "../src/state/types.js";

const mkRow = (id: number, body: string): SteeringRow => ({
  id,
  sessionId: "s1",
  source: "signal",
  sender: "+1me",
  body,
  status: "queued",
  createdAt: 0,
  consumedAt: null,
});

describe("mergedInput — ordered pane + steering mux", () => {
  it("emits steering rows in order and never double-emits an unconsumed row across polls", async () => {
    let rows: SteeringRow[] = [mkRow(1, "a"), mkRow(2, "b")];
    const gen = mergedInput({ steeringRows: () => rows, pollMs: 1 });

    expect((await gen.next()).value.body).toBe("a");
    expect((await gen.next()).value.body).toBe("b");

    // Rows 1 & 2 keep being returned by listQueued for a while; the mux must not
    // re-emit them. Then row 1 is "consumed" (drops out) and row 3 arrives.
    rows = [mkRow(2, "b"), mkRow(3, "c")];
    expect((await gen.next()).value.body).toBe("c");

    await gen.return(undefined);
  });

  it("reads pane lines, reassembles UTF-8 split across chunks, and EOF does NOT end the stream", async () => {
    const stdin = new PassThrough();
    let rows: SteeringRow[] = [];
    const gen = mergedInput({
      steeringRows: () => rows,
      pollMs: 2,
      stdin: stdin as unknown as NodeJS.ReadStream,
    });

    // "ök" with the 2-byte ö split across two writes, then a newline.
    stdin.write(Buffer.from([0xc3])); // first byte of ö
    stdin.write(Buffer.concat([Buffer.from([0xb6]), Buffer.from("k\n")]));
    const t = await gen.next();
    expect(t.value).toMatchObject({ body: "ök", source: "pane", steeringId: null });

    // Detached pane EOF must not terminate the stream.
    stdin.end();
    rows = [mkRow(7, "after-eof")];
    expect((await gen.next()).value.body).toBe("after-eof");

    await gen.return(undefined);
  });

  it("interleaves a pane line and a steering row into one stream", async () => {
    const stdin = new PassThrough();
    const rows: SteeringRow[] = [mkRow(1, "from-signal")];
    const gen = mergedInput({
      steeringRows: () => rows,
      pollMs: 2,
      stdin: stdin as unknown as NodeJS.ReadStream,
    });
    const bodies = new Set<string>();
    bodies.add((await gen.next()).value.body);
    stdin.write(Buffer.from("from-pane\n"));
    bodies.add((await gen.next()).value.body);
    expect(bodies).toEqual(new Set(["from-signal", "from-pane"]));
    await gen.return(undefined);
  });

  it("onPaneControl intercepts a pane line so it never becomes a model turn", async () => {
    const stdin = new PassThrough();
    const seen: string[] = [];
    const gen = mergedInput({
      steeringRows: () => [],
      pollMs: 2,
      stdin: stdin as unknown as NodeJS.ReadStream,
      // Swallow approval-style lines; let everything else flow as a turn.
      onPaneControl: (line) => {
        seen.push(line);
        return /^y|^n|^ya\b/.test(line);
      },
    });
    stdin.write(Buffer.from("ya 1a2b3c4d\n")); // consumed by onPaneControl
    stdin.write(Buffer.from("hello model\n")); // flows through as a turn
    const t = await gen.next();
    expect(t.value).toMatchObject({ body: "hello model", source: "pane" });
    expect(seen).toEqual(["ya 1a2b3c4d", "hello model"]); // both offered to the hook
    await gen.return(undefined);
  });

  it("stops cleanly on abort", async () => {
    const ac = new AbortController();
    let rows: SteeringRow[] = [mkRow(1, "x")];
    const gen = mergedInput({ steeringRows: () => rows, pollMs: 2, signal: ac.signal });
    expect((await gen.next()).value.body).toBe("x");
    rows = [];
    ac.abort();
    expect((await gen.next()).done).toBe(true);
  });

  it("drops undelivered queued turns on abort (stop before drain)", async () => {
    const ac = new AbortController();
    let rows: SteeringRow[] = [mkRow(1, "a"), mkRow(2, "b")];
    const gen = mergedInput({ steeringRows: () => rows, pollMs: 5, signal: ac.signal });
    expect((await gen.next()).value.body).toBe("a");
    ac.abort(); // "b" is queued but undelivered
    rows = [];
    expect((await gen.next()).done).toBe(true); // "b" dropped, stream ended
  });

  it("detaches pane stdin listeners on abort (cleanup, no leak)", async () => {
    const stdin = new PassThrough();
    const ac = new AbortController();
    const gen = mergedInput({
      steeringRows: () => [],
      pollMs: 5,
      stdin: stdin as unknown as NodeJS.ReadStream,
      signal: ac.signal,
    });
    const parked = gen.next(); // starts the generator; attaches stdin listeners
    await new Promise((r) => setTimeout(r, 10));
    expect(stdin.listenerCount("data")).toBeGreaterThan(0);
    ac.abort();
    expect((await parked).done).toBe(true); // returns done after abort
    expect(stdin.listenerCount("data")).toBe(0); // listeners detached in finally
  });
});
