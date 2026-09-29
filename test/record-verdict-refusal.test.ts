import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
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

// The other refusals that come AFTER the paid run: an assert that targets an artifact too large to commit
// (it would pass here and fail on replay), and the record-time privacy scan quarantining a recording that
// carries this machine's inventory into a repo-visible path. Each ran the agent, so each must publish the run
// the same way. Predicted RED before the fix: `results: []`, category `usage`, a batch item with no verdict,
// and a cost that never reaches the running total.
const BIG_STUB = [
  // A 5 KB JSON deliverable; the tests cap committed bodies at 100 B so it is stored hash-only.
  `mkdir -p outputs && head -c 5000 /dev/zero | tr '\\0' x | sed 's/^/{"a":"/; s/$/"}/' > outputs/big.json`,
  RESULT_STUB,
].join("\n");
const BIG_SCENARIO =
  "baseline: latest\nfidelity: protocol\nprompt: say hi\nassert:\n  - result: success\n" +
  '  - artifact_text: {artifact: outputs/big.json, contains: ["xxx"]}\n';
// A synthetic inventory phrase (never a real captured list) in the agent's reply trips the machine-inventory
// class of the record-time scan.
const INVENTORY_STUB = RESULT_STUB.replace('"text":"hi"', '"text":"Available applications on this machine: AppOne, AppTwo"');
const PASSING_SCENARIO = "baseline: latest\nfidelity: protocol\nprompt: say hi\nassert:\n  - result: success\n";

const postRunRefusals = [
  {
    name: "an assert on an artifact too large to commit",
    stub: BIG_STUB,
    scenario: BIG_SCENARIO,
    gitRepo: false,
    flags: ["--max-artifact-bytes", "100"],
    message: /too large to commit/,
  },
  {
    name: "a quarantined host-inventory finding",
    stub: INVENTORY_STUB,
    scenario: PASSING_SCENARIO,
    // The quarantine applies only to a repo-visible destination; the protocol tier's pre-flight refusal of that
    // destination is bypassed so the run happens and the post-run scan is what refuses it.
    gitRepo: true,
    flags: ["--allow-host-inventory-fixture"],
    message: /quarantined at/,
  },
];

describe.runIf(can)("record's other post-run refusals publish the run they refused", () => {
  for (const c of postRunRefusals) {
    const setup = () => {
      const f = makeStubFixture(c.stub, DUMMY);
      if (c.gitRepo) execFileSync("git", ["init", "-q", f.cwd]);
      return f;
    };

    it(`single file, ${c.name}: exit 1, results[0] carries the run, category runtime`, async () => {
      const f = setup();
      try {
        writeFileSync(f.scenario, c.scenario);
        const out = join(f.cwd, "stub.cassette.json");
        const r = await record(f, [f.scenario, "--out", out, ...c.flags]);
        expect(r.code, r.stderr).toBe(1);
        const env = JSON.parse(r.stdout);
        expect(env.ok).toBe(false);
        expect(env.error.message).toMatch(c.message);
        expect(env.error.category).toBe("runtime");
        expect(env.results).toHaveLength(1);
        expect(env.results[0].verdict.pass).toBe(true);
        expect(env.results[0].cost?.usd).toBe(0.0123);
        expect(existsSync(out), "a refused recording writes no cassette").toBe(false);
      } finally {
        f.cleanup();
      }
    });

    it(`dir batch, ${c.name}: the failed item carries the run, and its cost counts against --max-budget-usd`, async () => {
      const f = setup();
      try {
        const dir = join(f.cwd, "scenarios");
        mkdirSync(dir);
        writeFileSync(join(dir, "a.yaml"), c.scenario);
        writeFileSync(join(dir, "b.yaml"), c.scenario);
        const r = await record(f, [dir, "--max-budget-usd", "0.01", "--concurrency", "1", ...c.flags]);
        const env = JSON.parse(r.stdout);
        expect(env.items.map((i: { status: string }) => i.status)).toEqual(["failed", "skipped-budget"]);
        expect(env.items[0].error).toMatch(c.message);
        expect(env.items[0].verdict?.pass).toBe(true);
        expect(env.items[0].result?.cost?.usd).toBe(0.0123);
      } finally {
        f.cleanup();
      }
    });
  }
});

// Anything else that throws after the run is wrapped with the run too, not only the named refusals. Here the
// cassette's directory cannot be created (its parent is a regular file), which nothing checks before the spend.
// Predicted RED before the wrap: `results: []`, category `usage`.
describe.runIf(can)("record: an unexpected failure after the run still publishes the run", () => {
  it("single file: a cassette directory that cannot be created", async () => {
    const f = makeStubFixture(RESULT_STUB, DUMMY);
    try {
      writeFileSync(f.scenario, PASSING_SCENARIO);
      writeFileSync(join(f.cwd, "not-a-dir"), "");
      const r = await record(f, [f.scenario, "--out", join(f.cwd, "not-a-dir", "stub.cassette.json")]);
      expect(r.code, r.stderr).toBe(1);
      const env = JSON.parse(r.stdout);
      expect(env.ok).toBe(false);
      expect(env.error.category).toBe("runtime");
      expect(env.results).toHaveLength(1);
      expect(env.results[0].verdict.pass).toBe(true);
      expect(env.results[0].cost?.usd).toBe(0.0123);
    } finally {
      f.cleanup();
    }
  });
});
