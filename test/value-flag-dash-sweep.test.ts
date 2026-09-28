import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { SKILL_FLAG_SURFACE } from "../src/run/skill-flag-surface.js";
import { RECORD_VALUE_FLAGS } from "../src/run/cassette.js";

// A value-taking flag given a FLAG-LOOKING next token (`--label --dotenv`) must be a usage error naming that
// flag — never take the flag name as its value and carry on. Until `--dotenv`/`--run-dir` became per-command
// flags, a pre-dispatch guard happened to catch `--label --dotenv` and `record --model --run-dir`; once it
// went, those two silently proceeded. This sweeps EVERY value-taking flag of the lanes that run an agent, so
// a new flag cannot reopen the gap. Token-free: each case is refused at parse time.
const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);
const DASH = "--dotenv"; // flag-looking, and a real flag on every command now

const RUN_VALUE_FLAGS = [
  "--on-unanswered",
  "--output-format",
  "--decider-cmd",
  "--decider-dir",
  "--label",
  "--model",
  "--decider-model",
  "--matrix",
  "--max-cells",
  "--concurrency",
  "--repeat",
  "--min-pass-rate",
  "--max-budget-usd",
];
const SKILL_VALUE_FLAGS = [
  ...new Set([...SKILL_FLAG_SURFACE.filter((s) => s.arity === 1).map((s) => s.flag), "--on-unanswered", "--output-format", "--label"]),
].filter((f) => f !== "--dotenv" && f !== "--run-dir");
const CHAT_VALUE_FLAGS = ["--fidelity", "--model", "--upload", "--folder", "--plugin"];
const PROBE_VALUE_FLAGS = [
  "--fidelity",
  "--model",
  "--plugin",
  "--upload",
  "--folder",
  "--expect-write",
  "--on-unanswered",
  "--output-format",
  "--decider-cmd",
  "--decider-dir",
  "--label",
];

function cli(args: string[], cwd: string) {
  const r = spawnSync("node", [CLI, ...args], { encoding: "utf8", cwd, env: { ...process.env, COWORK_HARNESS_FORBID_SPAWN: "1" } });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const CASES: Array<[string, string[], string[]]> = [
  ["run", ["run", "s.yaml"], RUN_VALUE_FLAGS],
  ["skill", ["skill", "./plugin", "hi", "--dry-run"], SKILL_VALUE_FLAGS],
  ["record", ["record", "s.yaml", "--dry-run"], [...RECORD_VALUE_FLAGS]],
  ["chat", ["chat", "./plugin"], CHAT_VALUE_FLAGS],
  ["probe-dispatch", ["probe-dispatch", "./plugin", "hi"], PROBE_VALUE_FLAGS],
];

describe.skipIf(!can)("every value-taking flag refuses a flag-looking value", () => {
  it("the sweep is not empty", () => {
    for (const [, , flags] of CASES) expect(flags.length).toBeGreaterThan(4);
  });
  for (const [cmd, base, flags] of CASES) {
    for (const flag of flags) {
      it(`${cmd} ${flag} ${DASH} → usage error naming ${flag}`, () => {
        const d = mkdtempSync(join(tmpdir(), "dash-sweep-"));
        writeFileSync(
          join(d, "s.yaml"),
          "baseline: latest\nfidelity: container\non_unanswered: fail\nprompt: hello\nassert:\n  - result: success\n",
        );
        const r = cli([...base, flag, DASH], d);
        expect(r.code, r.out).toBe(2);
        expect(r.out, r.out).toMatch(new RegExp(esc(flag)));
        // …and it was not taken as the value and followed by a `--dotenv` missing-path error instead.
        expect(r.out).not.toMatch(/--dotenv requires a path/);
      });
    }
  }
});
