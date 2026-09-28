import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Several doc warnings existed only to steer users around an interface that has since been fixed:
//   - `--dotenv` / `--run-dir` had to come before the subcommand (now accepted after it, on every command);
//   - two different `scaffold` tools, the native one failing `unknown flag: --name` (now one command);
//   - `allow_stall` could not be used on the `skill` lane (now `--allow-stall`);
//   - a host-inventory flag on the wrong command failed as a bare unrecognized flag (now names the owner).
// A warning about a fixed interface is worse than none: it teaches a rule that is false. This guard keeps
// each one from coming back to the shipped skill or the docs.

export const WORKAROUND_NEEDLES: Array<[string, RegExp]> = [
  ["--dotenv/--run-dir must precede the subcommand", /\bprecede the subcommand|PRECEDE the subcommand/i],
  [
    "--dotenv/--run-dir is a GLOBAL flag",
    /(--dotenv|--run-dir)[^\n]{0,60}\bGLOBAL\b|\bglobal\b\*{0,2}\s+`(--dotenv|--run-dir)|A \*\*global\*\* flag|\*before\* the subcommand/,
  ],
  ["put --dotenv before the subcommand", /put it BEFORE the subcommand/i],
  ["two different scaffold tools", /Two different `scaffold` tools/i],
  ["native scaffold rejects --name", /unknown flag: --name/],
  ["scenario.py scaffold presented as a separate tool", /scenario\.py scaffold[^\n]*distinct from `cowork-harness scaffold/],
  [
    "the skill lane cannot use allow_stall",
    /`skill` lane cannot use it|Scenario-only:\*\* an open-ended `skill` run has no `assert:` block, so it cannot opt out/,
  ],
  ["a host-inventory flag on the wrong command is a bare unknown flag", /fails as an unrecognized flag — they don't interchange/],
];

const SKILL = ".claude/skills/cowork-harness";
const FILES = [
  join(SKILL, "SKILL.md"),
  ...readdirSync(join(SKILL, "references")).map((f) => join(SKILL, "references", f)),
  "README.md",
  "llms.txt",
  ...readdirSync("docs")
    .filter((f) => f.endsWith(".md"))
    .map((f) => join("docs", f)),
];

export function workaroundHits(file: string, text: string): string[] {
  const hits: string[] = [];
  for (const [label, re] of WORKAROUND_NEEDLES) if (re.test(text)) hits.push(`${file}: ${label}`);
  return hits;
}

describe("no doc still warns around an interface that has been fixed", () => {
  it("the shipped skill, README and docs/ carry none of the retired workaround warnings", () => {
    const hits = FILES.flatMap((f) => workaroundHits(f, readFileSync(f, "utf8")));
    expect(hits, hits.join("\n")).toEqual([]);
  });

  it("each needle still matches the sentence it was written for (the guard is not vacuous)", () => {
    const samples = [
      "--run-dir stays global — it must PRECEDE the subcommand",
      "the `--run-dir <path>` flag — a **global** flag that must precede the subcommand",
      "relocate with the global `--run-dir <path>` flag — it goes *before* the subcommand",
      "**`--dotenv` is a GLOBAL flag — put it BEFORE the subcommand.**",
      "**Two different `scaffold` tools — don't confuse them.**",
      "Passing that section's flag set to the native command fails with `unknown flag: --name` (exit 2).",
      "`python3 …/scenario.py scaffold --name <name>` — a skeleton from scratch (distinct from `cowork-harness scaffold <run-id | run-dir>`)",
      "27. **`allow_stall: true` is a scenario assertion, so the `skill` lane cannot use it.**",
      "Passing one where the other command wants it fails as an unrecognized flag — they don't interchange.",
    ];
    for (const [label, re] of WORKAROUND_NEEDLES)
      expect(
        samples.some((s) => re.test(s)),
        label,
      ).toBe(true);
  });
});
