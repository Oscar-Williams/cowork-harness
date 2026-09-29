import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLI, POSIX, credentialLeaks, exited, makeStubFixture, spawnCli, type StubFixture } from "./helpers/stub-agent.js";

// The --rerecord-stale arm of record's post-run refusal (the dir and single-file arms are in
// record-verdict-refusal.test.ts). Two cassettes are recorded with --allow-failing (the stub's run fails its verdict), made
// stale by baseline drift, then re-recorded WITHOUT --allow-failing under a running-total cap the first
// refused run's cost already exceeds. Predicted: item 1 failed (with verdict/result), item 2 skipped-budget.
const DUMMY = { ANTHROPIC_API_KEY: "stub-placeholder-not-a-credential" };
const can = POSIX && existsSync(CLI);
const RESULT_STUB = [
  `printf '%s\\n' '{"type":"system","subtype":"init","session_id":"stub","model":"claude-sonnet-5","tools":[],"cwd":"/tmp"}'`,
  `printf '%s\\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]},"session_id":"stub"}'`,
  `printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":"hi","session_id":"stub","num_turns":1,"total_cost_usd":0.0123,"usage":{"input_tokens":1,"output_tokens":1}}'`,
  "cat >/dev/null",
].join("\n");
const FAILING = (name: string) => `name: ${name}\nbaseline: latest\nfidelity: protocol\nprompt: say hi\nassert:\n  - result: error\n`;

async function record(f: StubFixture, args: string[]) {
  const cli = spawnCli(f, ["record", ...args, "--output-format", "json"]);
  const r = await exited(cli, 40_000);
  expect(credentialLeaks(f.envDump)).toEqual(["ANTHROPIC_API_KEY"]);
  return { ...r, stdout: cli.stdoutText(), stderr: cli.stderrText() };
}

describe.runIf(can)("record --rerecord-stale refused on a failing verdict", () => {
  it("failed item carries verdict/result and its cost counts against --max-budget-usd", async () => {
    const f = makeStubFixture(RESULT_STUB, DUMMY);
    try {
      const dir = join(f.cwd, "scenarios");
      mkdirSync(dir);
      writeFileSync(join(dir, "a.yaml"), FAILING("a"));
      writeFileSync(join(dir, "b.yaml"), FAILING("b"));
      // Seed: two cassettes at the default path, recorded with --allow-failing.
      const seed = await record(f, [dir, "--allow-failing"]);
      expect(seed.code, seed.stderr).toBe(0);
      const cdir = join(f.cwd, "cassettes");
      const files = readdirSync(cdir)
        .filter((n) => n.endsWith(".cassette.json"))
        .sort();
      expect(files).toEqual(["a.cassette.json", "b.cassette.json"]);
      for (const n of files) {
        const c = JSON.parse(readFileSync(join(cdir, n), "utf8"));
        c.fingerprint.baseline = "desktop-0.0.1"; // baseline drift → stale
        writeFileSync(join(cdir, n), JSON.stringify(c));
      }
      // A fresh runs dir: no priced history, so the pre-flight proceeds UNCAPPED and the running total is
      // what stops the batch.
      const fresh = join(f.root, "runs2");
      mkdirSync(fresh);
      f.env.COWORK_HARNESS_RUNS_DIR = fresh;
      const r = await record(f, [cdir, "--rerecord-stale", "--max-budget-usd", "0.01", "--concurrency", "1"]);
      expect(r.code, r.stderr).toBe(1);
      const env = JSON.parse(r.stdout);
      expect(env.ok).toBe(false);
      expect(env.items.map((i: { status: string }) => i.status)).toEqual(["failed", "skipped-budget"]);
      expect(env.items[0].error).toMatch(/refusing to freeze a failing run/);
      expect(env.items[0].verdict?.pass).toBe(false);
      expect(env.items[0].result?.cost?.usd).toBe(0.0123);
    } finally {
      f.cleanup();
    }
  });
});
