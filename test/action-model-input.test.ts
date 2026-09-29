import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// The Action's `model` input reaches the CLI as COWORK_HARNESS_MODEL, and only when it is set: the step-level
// `env:` maps it to HARNESS_MODEL, and the run script exports it when non-empty. An unconditional export
// would put an empty COWORK_HARNESS_MODEL on the step, masking a job-level one the consumer set.
//
// Executed, not text-matched: the export line is lifted out of action.yml and run under bash, so a change
// that inverts or drops the guard fails here, not in a consumer's workflow.
const actionYml = readFileSync(resolve("action.yml"), "utf8");
const runStep = actionYml.slice(actionYml.indexOf("Run cowork-harness"), actionYml.indexOf("- name: Report"));
const exportLine = runStep.split("\n").find((l) => l.includes("COWORK_HARNESS_MODEL=") && l.includes("HARNESS_MODEL"));

function modelSeen(env: Record<string, string>): string {
  const r = spawnSync("bash", ["-c", `${exportLine!.trim()}\nprintf '%s' "\${COWORK_HARNESS_MODEL-<unset>}"`], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
  });
  return r.stdout;
}

describe("action.yml — the `model` input", () => {
  it("is declared as an input and mapped to HARNESS_MODEL on the run step", () => {
    expect(actionYml).toMatch(/^ {2}model:\s*$/m);
    expect(runStep).toMatch(/HARNESS_MODEL: \$\{\{ inputs\.model \}\}/);
    expect(exportLine, "no export line for COWORK_HARNESS_MODEL in the run step").toBeDefined();
  });

  it("exports COWORK_HARNESS_MODEL when the input is set", () => {
    expect(modelSeen({ HARNESS_MODEL: "claude-sonnet-5" })).toBe("claude-sonnet-5");
  });

  it("exports nothing when the input is empty, so a job-level value survives", () => {
    expect(modelSeen({ HARNESS_MODEL: "" })).toBe("<unset>");
    expect(modelSeen({ HARNESS_MODEL: "", COWORK_HARNESS_MODEL: "claude-haiku-4-5" })).toBe("claude-haiku-4-5");
  });
});
