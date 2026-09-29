import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { jsonEnvelope, jsonPayloadEnvelope, publishedResult } from "../src/run/envelope.js";
import type { RunResult } from "../src/types.js";

// Single-file `record` now emits through jsonPayloadEnvelope (its `ok` is "exited 0", not the verdict), where
// it used jsonEnvelope. The success arm cannot run token-free, so this pins the claim that the SHAPE did not
// move: the two serializers, fed the same recorded result, agree on every key, in the same order, and on
// every value but `ok`. A drift in either (a key added to one frame, a different projection of the result)
// fails here.
function result(pass: boolean): RunResult {
  return {
    scenario: "smoke",
    fidelity: "container",
    baseline: "desktop-1.14271.0",
    result: "success",
    decisions: [],
    toolCounts: { Read: 1 },
    gateDeliveries: [],
    egress: [],
    assertions: [{ assertion: { tool_called: "Read" }, pass }],
    subagents: [],
    outDir: "/tmp/x",
    workDir: "/tmp/x/work/session/mnt",
    durationMs: 1,
    scan: { outputsDeletes: [], hostPathLeaked: false, selfHealRan: false },
  } as unknown as RunResult;
}

describe("single-file record: the payload frame matches the results[] frame except ok", () => {
  for (const pass of [true, false]) {
    it(`a ${pass ? "passing" : "failing"} recorded run`, () => {
      const r = result(pass);
      const before = JSON.parse(jsonEnvelope("record", [r], { extra: { artifacts: 2, cassette: "cassettes/smoke.cassette.json" } }));
      const after = JSON.parse(
        jsonPayloadEnvelope("record", true, { results: [publishedResult(r)], artifacts: 2, cassette: "cassettes/smoke.cassette.json" }),
      );
      expect(Object.keys(after)).toEqual(Object.keys(before));
      const { ok: okBefore, ...restBefore } = before;
      const { ok: okAfter, ...restAfter } = after;
      expect(restAfter).toEqual(restBefore);
      // The verdict still says what the run did; only `ok` stopped mirroring it.
      expect(after.results[0].verdict.pass).toBe(pass);
      expect(okBefore).toBe(pass);
      expect(okAfter).toBe(true);
    });
  }
});

// STRUCTURAL: the test above proves the two frames agree; this proves `record` uses the one whose `ok` is
// "exited 0". The single-file arm's success emit is the only `record` envelope written after a recording, and
// it must not go back to jsonEnvelope (whose `ok` is the verdict). `SRC` may be overridden to point the
// check at another copy of the file (how its red was confirmed against the pre-change source).
describe("cmdRecord's single-file arm emits ok = exited 0", () => {
  const SRC = readFileSync(resolve(process.env.RECORD_ENVELOPE_SRC ?? "src/run/cassette.ts"), "utf8");
  const start = SRC.indexOf("export async function cmdRecord(");
  const body = SRC.slice(start, SRC.indexOf("\n}\n", start));

  it("the scan found cmdRecord and its single-file recording call", () => {
    expect(start).toBeGreaterThan(0);
    expect(body).toMatch(/await recordScenarioObject\(\s*scenario!/);
  });

  it("no record envelope in cmdRecord derives ok from the verdict (jsonEnvelope)", () => {
    expect(body).not.toMatch(/jsonEnvelope\(\s*"record"/);
  });

  it("the single-file success emit is a payload envelope with ok: true and the published result", () => {
    const arm = body.slice(body.search(/await recordScenarioObject\(\s*scenario!/));
    expect(arm).toMatch(/jsonPayloadEnvelope\(\s*"record",\s*true,\s*\{\s*results:\s*\[publishedResult\(r\.result\)\]/);
  });
});
