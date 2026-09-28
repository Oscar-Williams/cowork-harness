import { describe, it, expect } from "vitest";
import { assertSpawnAllowed } from "../src/run/execute.js";

// The unit lane's spawn guard (test/setup/forbid-spawn.ts). executeScenario calls assertSpawnAllowed at
// the top of its stage/launch step, so a scenario a load-time refusal SHOULD have rejected fails red here
// instead of launching a real agent. Only the pure predicate is exercised: driving executeScenario past
// its refusals is exactly what this guard exists to stop.
describe("COWORK_HARNESS_FORBID_SPAWN", () => {
  it("is set for every unit-lane test by the setup file", () => {
    expect(process.env.COWORK_HARNESS_FORBID_SPAWN).toBe("1");
  });

  it("throws when set, naming the scenario and why", () => {
    expect(() => assertSpawnAllowed("s1", { COWORK_HARNESS_FORBID_SPAWN: "1" })).toThrow(/refusing to stage or launch.*s1/s);
  });

  it("is inert when unset or 0", () => {
    expect(() => assertSpawnAllowed("s1", {})).not.toThrow();
    expect(() => assertSpawnAllowed("s1", { COWORK_HARNESS_FORBID_SPAWN: "0" })).not.toThrow();
  });
});
