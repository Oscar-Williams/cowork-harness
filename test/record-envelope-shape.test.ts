import { describe, it, expect } from "vitest";
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
