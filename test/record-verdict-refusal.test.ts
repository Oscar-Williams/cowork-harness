import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLI, POSIX, credentialLeaks, exited, makeStubFixture, spawnCli, type StubFixture } from "./helpers/stub-agent.js";

// `record` refuses to freeze a run whose verdict failed (no --allow-failing). The run still happened and
// still cost money, so the refusal must publish it: under --output-format json the documented read
// `results[0].verdict.pass` has to resolve on this path too, and the category must not be `usage` (the
// scenario loaded and ran; nothing about the caller's input was wrong).
//
// The stub agent answers one clean turn with a priced `result` frame; the scenario asserts `result: error`,
// so the run succeeds and the verdict fails. No agent, no spend.
//
// `record` has a credential guard before any spawn, so the fixture needs a non-empty credential variable.
// The value is a placeholder, never a real token; the stub never calls an API.
const DUMMY = { ANTHROPIC_API_KEY: "stub-placeholder-not-a-credential" };
const can = POSIX && existsSync(CLI);
const RESULT_STUB = [
  `printf '%s\\n' '{"type":"system","subtype":"init","session_id":"stub","model":"claude-sonnet-5","tools":[],"cwd":"/tmp"}'`,
  `printf '%s\\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]},"session_id":"stub"}'`,
  `printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":"hi","session_id":"stub","num_turns":1,"total_cost_usd":0.0123,"usage":{"input_tokens":1,"output_tokens":1}}'`,
  // Drain stdin and exit when the harness closes it; a stub that sleeps instead turns the run into `error`.
  "cat >/dev/null",
].join("\n");
const FAILING_SCENARIO = "baseline: latest\nfidelity: protocol\nprompt: say hi\nassert:\n  - result: error\n";

async function record(f: StubFixture, args: string[]) {
  const cli = spawnCli(f, ["record", ...args, "--output-format", "json"]);
  const r = await exited(cli, 25_000);
  // Only the placeholder may reach the agent.
  expect(credentialLeaks(f.envDump)).toEqual(["ANTHROPIC_API_KEY"]);
  return { ...r, stdout: cli.stdoutText(), stderr: cli.stderrText() };
}

describe.runIf(can)("record refused on a failing verdict publishes the run it refused", () => {
  // Predicted RED before the fix: `results` is `[]` (so results[0] is undefined) and error.category is "usage".
  it("single file: exit 1, ok:false, results[0] carries the failing verdict and the cost, category runtime", async () => {
    const f = makeStubFixture(RESULT_STUB, DUMMY);
    try {
      writeFileSync(f.scenario, FAILING_SCENARIO);
      const out = join(f.cwd, "stub.cassette.json");
      const r = await record(f, [f.scenario, "--out", out]);
      expect(r.code, r.stderr).toBe(1);
      const env = JSON.parse(r.stdout);
      expect(env.ok).toBe(false);
      expect(env.results).toHaveLength(1);
      expect(env.results[0].verdict.pass).toBe(false);
      expect(env.results[0].result).toBe("success");
      expect(env.results[0].cost?.usd).toBe(0.0123);
      expect(env.error.category).toBe("runtime");
      expect(env.error.message).toMatch(/refusing to freeze a failing run/);
      expect(existsSync(out), "a refused recording writes no cassette").toBe(false);
    } finally {
      f.cleanup();
    }
  });

  // Predicted RED before the fix: the failed item carries only `error`.
  it("dir batch: the failed item carries the run's verdict and result", async () => {
    const f = makeStubFixture(RESULT_STUB, DUMMY);
    try {
      const dir = join(f.cwd, "scenarios");
      mkdirSync(dir);
      writeFileSync(join(dir, "stub.yaml"), FAILING_SCENARIO);
      const r = await record(f, [dir]);
      expect(r.code, r.stderr).toBe(1);
      const env = JSON.parse(r.stdout);
      expect(env.ok).toBe(false);
      expect(env.items).toHaveLength(1);
      const item = env.items[0];
      expect(item.status).toBe("failed");
      expect(item.error).toMatch(/refusing to freeze a failing run/);
      expect(item.verdict?.pass).toBe(false);
      expect(item.result?.cost?.usd).toBe(0.0123);
      expect(item.cassette).toBeUndefined();
    } finally {
      f.cleanup();
    }
  });

  // The refused run was paid for, so it counts toward a batch's running total: at --concurrency 1 a cap
  // below the first run's cost must skip the second. Predicted RED before the fix: both items run.
  it("dir batch: a refused run's cost counts against --max-budget-usd", async () => {
    const f = makeStubFixture(RESULT_STUB, DUMMY);
    try {
      const dir = join(f.cwd, "scenarios");
      mkdirSync(dir);
      writeFileSync(join(dir, "a.yaml"), FAILING_SCENARIO);
      writeFileSync(join(dir, "b.yaml"), FAILING_SCENARIO);
      const r = await record(f, [dir, "--max-budget-usd", "0.01", "--concurrency", "1"]);
      const env = JSON.parse(r.stdout);
      expect(env.items.map((i: { status: string }) => i.status)).toEqual(["failed", "skipped-budget"]);
    } finally {
      f.cleanup();
    }
  });
});
