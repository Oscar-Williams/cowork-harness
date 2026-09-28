import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeSemanticJudge } from "../src/decide/semantic-judge.js";
import { applyCommandGlobal, resetCommandGlobalsForTest } from "../src/run/command-globals.js";

// COWORK_HARNESS_JUDGE_MODEL used to be read into a module-level const at import time — before main() loads
// any .env — so neither ./.env nor --dotenv (in either position) could ever set it. It is read at use now.
describe("COWORK_HARNESS_JUDGE_MODEL is read when the judge is built, not at import", () => {
  it("a value that arrives after import (as a --dotenv file's does) is the model the judge calls", async () => {
    const prior = process.env.COWORK_HARNESS_JUDGE_MODEL;
    delete process.env.COWORK_HARNESS_JUDGE_MODEL;
    const d = mkdtempSync(join(tmpdir(), "judge-model-"));
    writeFileSync(join(d, "e.env"), "COWORK_HARNESS_JUDGE_MODEL=claude-judge-from-dotenv\n");
    resetCommandGlobalsForTest();
    try {
      applyCommandGlobal("run", "--dotenv", join(d, "e.env"), false);
      const models: string[] = [];
      const judge = makeSemanticJudge({
        complete: async (_prompt, model) => {
          models.push(model);
          return { text: "not a grade", model }; // only the model the call was made with is under test
        },
      });
      await judge(["c"], "answer").catch(() => undefined); // the parse of the stub reply is not under test
      expect(models).toEqual(["claude-judge-from-dotenv"]);
    } finally {
      resetCommandGlobalsForTest();
      if (prior === undefined) delete process.env.COWORK_HARNESS_JUDGE_MODEL;
      else process.env.COWORK_HARNESS_JUDGE_MODEL = prior;
    }
  });
});
