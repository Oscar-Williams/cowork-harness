import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

// Recipe 5 (evaluate answer quality) and the measurement hygiene list must not overclaim:
//  - a rep where the skill was not invoked did NOT necessarily answer from priors — the skill's source is
//    mounted and readable, so the model may have read it directly (gotcha 26);
//  - a before/after drop is a signal to investigate, not proof the edit caused it;
//  - "commit the skill" is one way to freeze a recoverable source, not the requirement.
// Needles are matched on whitespace-normalised text, so a phrase wrapped across lines still counts.

const SKILL = resolve(".claude/skills/cowork-harness");
const REFS = join(SKILL, "references");
const norm = (s: string) => s.replace(/\s+/g, " ");
const files = [
  "SKILL.md",
  ...readdirSync(REFS)
    .filter((f) => f.endsWith(".md"))
    .map((f) => join("references", f)),
];
const corpus = files.map((f) => ({ f, text: norm(readFileSync(join(SKILL, f), "utf8")) }));
const recipes = norm(readFileSync(join(REFS, "task-recipes.md"), "utf8"));
const recipe5 = recipes.slice(recipes.indexOf("## Recipe 5"), recipes.indexOf("## Recipe 6"));
const measurement = norm(readFileSync(join(REFS, "measurement.md"), "utf8"));

describe("Recipe 5 / measurement: no overclaims", () => {
  it("read a sane corpus (Recipe 5 and the measurement reference were found)", () => {
    expect(corpus.length).toBeGreaterThan(5);
    expect(recipe5.length).toBeGreaterThan(1000);
    expect(measurement).toMatch(/Measurement hygiene/);
  });

  for (const [label, re] of [
    ["not invoked ⇒ answered from priors", /answered from the model's priors/i],
    ["a drop is a regression the edit caused", /regression your edit caused/i],
    ["commit the skill first / before", /commit the skill (first|before)/i],
    ["a not-invoked rep measures the model", /never triggered is a measurement of the model/i],
  ] as const)
    it(`no reference says: ${label}`, () => {
      expect(corpus.filter(({ text }) => re.test(text)).map(({ f }) => f)).toEqual([]);
    });
});

describe("Recipe 5: the three-way classification", () => {
  it("names invocation, observed source access and answer quality", () => {
    expect(recipe5).toMatch(/skillsInvoked/);
    expect(recipe5).toMatch(/observed source access/i);
    expect(recipe5).toMatch(/answer quality/i);
  });

  it("gives the object form of tool_called as the source-access check, and says input_any is not proof of a read", () => {
    expect(recipe5).toMatch(/tool_called: \{tool: \[Read, Grep, Bash, mcp__workspace__bash\], input_any: 'SKILL\\\.md', scope: any\}/);
    expect(recipe5).toMatch(/reference_read/);
    expect(recipe5).toMatch(/not proof the file was read/i);
  });

  it("scopes 'the source is readable' to non-ablated reps", () => {
    expect(recipe5).toMatch(/non-ablated rep/i);
    expect(recipe5).toMatch(/--ablate-skill.{0,120}no skill mounted/i);
  });

  it("frames a before/after drop as a signal to investigate", () => {
    expect(recipe5).toMatch(/regression signal to investigate/i);
    expect(recipe5).toMatch(/not proof your edit caused it/i);
  });

  it("the measurement hygiene item uses the same wording and links Recipe 5", () => {
    expect(measurement).toMatch(/observed source access/i);
    expect(measurement).toMatch(/Recipe 5/);
  });

  it("both hygiene lists say to freeze a recoverable source", () => {
    expect(measurement).toMatch(/freeze a recoverable source/i);
    expect(recipes).toMatch(/freeze a recoverable source/i);
  });
});
