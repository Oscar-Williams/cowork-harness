import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// What `replay` does with a frozen top-level scenario key an OLDER CLI does not recognize is decided by the
// recorder's cassette stamp (KEY_REQUIRED_VERSION in src/run/cassette.ts), not by the reader:
//   - a key that changes what a verdict MEANS lifts the stamp, so the older reader refuses the cassette as
//     too new (`replay` and `verify-cassettes` both; only `replay --best-effort-future-cassette` proceeds,
//     and it names the unknown key in a notice);
//   - a meaning-neutral key leaves the stamp alone and is ignored by design (the frozen scenario is a
//     forward-tolerant passthrough).
// The docs used to say a frozen `lane:` is "silently ignored" and "can flip a verdict". Both mechanisms
// above (pinned in test/replay-assert-from.test.ts and test/cassette-version-stamp.test.ts) make that false.
// This guard keeps the overclaim from coming back to any page that describes the replay contract.

const SKILL = ".claude/skills/cowork-harness";
const REFS = join(SKILL, "references");
const FILES = [join(SKILL, "SKILL.md"), ...readdirSync(REFS).map((f) => join(REFS, f)), "docs/scenario.md", "docs/cassette.md"];

/** Every "silently ignored" (or "can flip … verdict") claim that sits near `lane` and `replay`/`frozen`. */
function overclaims(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const hits: string[] = [];
  for (const m of text.matchAll(/silently ignored|can flip a [\w-]*\s*[\w' -]*verdict/gi)) {
    const at = m.index ?? 0;
    const window = text.slice(Math.max(0, at - 400), at + 400);
    if (/\blane\b/.test(window) && /\breplay\b|\bfrozen\b/i.test(window))
      hits.push(`${file}: …${text.slice(Math.max(0, at - 60), at + 60).replace(/\s+/g, " ")}…`);
  }
  return hits;
}

describe("replay's unknown-frozen-key contract is stated as the stamp mechanism, not as a silent flip", () => {
  it("no page says a frozen `lane:` is silently ignored or can flip a verdict", () => {
    const hits = FILES.flatMap(overclaims);
    expect(hits, hits.join("\n")).toEqual([]);
  });

  it("the corrected statement is present where the old one was (the guard above is not vacuous by deletion)", () => {
    const authoring = readFileSync(join(REFS, "authoring.md"), "utf8");
    const scenarioDoc = readFileSync("docs/scenario.md", "utf8");
    for (const [name, text] of [
      ["references/authoring.md", authoring],
      ["docs/scenario.md", scenarioDoc],
    ] as const) {
      expect(text, `${name} should say a meaning-changing key makes an older CLI refuse the cassette as too new`).toMatch(/too new/);
      expect(text, `${name} should say a meaning-neutral key is ignored by design`).toMatch(/ignored by design/);
    }
  });
});

// A `lane: remote` cassette is stamped v11 only when RECORDED on >= 1.16.0: one recorded by 1.14.0/1.15.0 is
// v10, and a pre-`lane` CLI ignores the key there. Every sentence that credits the stamp with the refusal
// has to carry that qualifier, or it overclaims in the other direction.
describe("the lane: remote stamp claim carries its recorded-on-1.16.0 qualifier", () => {
  const unreleased = (() => {
    const c = readFileSync("CHANGELOG.md", "utf8");
    return c.slice(c.indexOf("## [Unreleased]"), c.indexOf("\n## [", c.indexOf("## [Unreleased]") + 1));
  })();
  const SITES: Array<[string, string]> = [
    ["references/authoring.md", readFileSync(join(REFS, "authoring.md"), "utf8")],
    ["references/scenario-schema.md", readFileSync(join(REFS, "scenario-schema.md"), "utf8")],
    ["docs/scenario.md", readFileSync("docs/scenario.md", "utf8")],
    ["CHANGELOG [Unreleased]", unreleased],
  ];
  for (const [name, text] of SITES)
    it(`${name}: every "lane: remote raises the stamp" claim names 1.16.0`, () => {
      const claims = [...text.matchAll(/lane: (?:"?remote"?)[`)]*[^]{0,120}?\b(?:raises|raised)\b/g)];
      expect(claims.length, `${name} no longer states the stamp mechanism — re-point this guard`).toBeGreaterThan(0);
      for (const m of claims) {
        const at = m.index ?? 0;
        const window = text.slice(Math.max(0, at - 300), at + 400);
        expect(window, `${name}: …${text.slice(at, at + 120)}…`).toMatch(/1\.16\.0/);
      }
    });

  it("docs/scenario.md gives each command's too-new exit code: verify-cassettes 3, replay 1", () => {
    const doc = readFileSync("docs/scenario.md", "utf8");
    expect(doc).toMatch(/`verify-cassettes`[^\n]{0,80}`3`/);
    expect(doc).toMatch(/`replay`[^\n]{0,80}`1`/);
  });
});
