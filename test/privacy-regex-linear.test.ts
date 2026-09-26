import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { TARGETS, ROOTS, POLICY_SOURCES, inputsFor } from "./helpers/privacy-regex-probe.js";
import { DEFAULT_SCAN_PATTERNS } from "../src/scan.js";

/**
 * The privacy scanner (`verify-cassettes`) and the reference redaction policy (`record`) run their regexes over
 * whole cassettes, including raw event lines of 100 KB and more. A regex whose cost grows with the square of an
 * unbroken run — a local part with no `@`, a run of one repeated path root with no `/mnt/` — turns one such line
 * into seconds, and a long recording into a stall. This guard runs every scanner class, every rule of the shipped
 * `.cowork-redact.json`, `hostPathLeaked` and two end-to-end passes over 200k-character adversarial inputs.
 *
 * Each target runs in a CHILD process with a hard SIGKILL: a regression FAILS here instead of blocking the worker
 * (an in-process timing assertion cannot fire while the regex holds the thread). The kill timeout is scaled to the
 * work a child does — it only bounds a genuine hang; the real assertion is the per-input time measured inside the
 * child. Budgets are 1 s per input for one regex and 2 s for an end-to-end pass: the linear versions take about
 * 0.1 s at worst, the quadratic ones they replaced took 3–22 s on these inputs (and are killed).
 *
 * `npm run ci` runs this in the default lane on every supported Node version, alongside the rest of the suite.
 * Targets are derived from the shipped code and policy, so a new class or rule is covered without an edit here.
 */
const PROBE = join(process.cwd(), "test/helpers/privacy-regex-probe.ts");
const E2E_KILL_MS = 60_000;
const killMs = (inputs: number) => Math.max(10_000, 500 * inputs);

describe("privacy regexes run in linear time", () => {
  it("covers every scanner class, every policy rule, hostPathLeaked and both end-to-end passes", () => {
    expect(Object.keys(TARGETS)).toHaveLength(DEFAULT_SCAN_PATTERNS.length + POLICY_SOURCES.length + 3);
  });
  it("finds every path root the policy names (so each gets its own adversarial inputs)", () => {
    for (const r of ["/Users/", "/home/", "/root/", "/private/tmp/", "/private/var/", "/var/folders/", "/System/Volumes/", "/Volumes/"])
      expect(ROOTS).toContain(r);
  });

  for (const name of Object.keys(TARGETS)) {
    const e2e = TARGETS[name].e2e === true;
    const inputs = Object.keys(inputsFor(name)).length;
    const kill = e2e ? E2E_KILL_MS : killMs(inputs);
    it(
      name,
      () => {
        const r = spawnSync(process.execPath, ["--import", "tsx", PROBE, name], { encoding: "utf8", timeout: kill, killSignal: "SIGKILL" });
        expect(r.signal, `probe was killed after ${kill} ms (a regex did not finish): ${name}`).toBeNull();
        expect(r.status, r.stderr).toBe(0);
        const { perInput } = JSON.parse(r.stdout.trim().split("\n").pop() ?? "{}") as { perInput: Record<string, number> };
        expect(Object.keys(perInput)).toHaveLength(inputs);
        const budget = e2e ? 2000 : 1000;
        const over = Object.entries(perInput).filter(([, ms]) => ms >= budget);
        expect(over.map(([i, ms]) => `${i}: ${Math.round(ms)} ms`)).toEqual([]);
      },
      kill + 15_000,
    );
  }
});
