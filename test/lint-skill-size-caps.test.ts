import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { collectStamps } from "../scripts/check-claims.js";

// The lint-skill size caps (a SKILL.md body over 19,000 B; a reference over 60,000 B) come from reading one
// agent build, not from an observed truncation. They live ONCE, in scenario.py — no TS consumer exists, so
// there is deliberately no mirror to sync. What keeps them honest is the adjacent stamp naming the build
// they were read from, and `check:claims` reporting that stamp's age. This pins both halves: a stamp that
// drifted out of the recognisable shape, or a claims walk that stopped reaching the payload, would each
// leave the caps silently unaged.
const SCENARIO_PY = ".claude/skills/cowork-harness/scripts/scenario.py";
const py = readFileSync(resolve(SCENARIO_PY), "utf8");

describe("lint-skill size caps: single source + binary-verification stamp", () => {
  const stamp = /^_SKILL_SIZE_CAPS_VERIFIED = "binary-verified against agent (\d+\.\d+\.\d+) \(VM ELF and native, both read\)"$/m.exec(py);

  it("scenario.py carries a well-formed stamp naming the agent build the caps were read from", () => {
    expect(stamp, "the _SKILL_SIZE_CAPS_VERIFIED stamp is missing or malformed").toBeTruthy();
  });

  it("the stamp sits beside the caps it vouches for (not somewhere a reader of the constants would miss it)", () => {
    const lines = py.split("\n");
    const at = (re: RegExp) => lines.findIndex((l) => re.test(l));
    const s = at(/^_SKILL_SIZE_CAPS_VERIFIED = /);
    for (const c of [/^_SKILL_BODY_REATTACH_CAP = 19_000$/, /^_SKILL_REFERENCE_READ_CAP = 60_000$/]) {
      const i = at(c);
      expect(i, `${c} not found`).toBeGreaterThan(-1);
      expect(Math.abs(i - s), `${c} is not adjacent to the stamp`).toBeLessThanOrEqual(4);
    }
  });

  it("check:claims reaches the payload's .py and records the stamp, so its age is reported against the pin", () => {
    const hits = collectStamps().filter((s) => s.file === SCENARIO_PY && s.kind === "agent");
    expect(
      hits.map((h) => h.version),
      "check:claims did not see the size-cap stamp in scenario.py",
    ).toContain(stamp?.[1]);
  });
});
