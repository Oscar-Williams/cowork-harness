import { describe, it, expect } from "vitest";
import { checkBaselinePinClaims } from "../scripts/check-versions.js";

/**
 * Invariant 15 (check:versions) — no "currently `desktop-X`" pin in shipped prose, and no real version in an
 * issue template.
 *
 * Every case below is a way the claim can go wrong and must be observed to FAIL, plus the accepted shapes a
 * guard like this must not flag: the spawn-contract doc it exempts, a dated historical mention, and a
 * version-free template.
 */

const TEMPLATE_OK = {
  path: ".github/ISSUE_TEMPLATE/bug_report.yml",
  text: 'placeholder: "X.Y.Z (npm -g)"\nplaceholder: "desktop-X.Y.Z / app X.Y.Z / agent X.Y.Z"\nplaceholder: "macOS 15 arm64, Node 22.13, Docker 27"\n',
};

describe("checkBaselinePinClaims", () => {
  it("accepts version-free templates and prose that names a baseline without claiming it is current", () => {
    expect(
      checkBaselinePinClaims([
        TEMPLATE_OK,
        { path: "README.md", text: "The latest shipped baseline is **`desktop-9.9.9`**. Verified on `desktop-1.12603.1`." },
        { path: "DESIGN.md", text: "currently **2.1.281**, per `baselines/desktop-9.9.9.json`" },
      ]),
    ).toEqual([]);
  });

  it("rejects the real historical index text, with a line number", () => {
    const errors = checkBaselinePinClaims([
      TEMPLATE_OK,
      { path: "llms.txt", text: "intro\n- the live values are baselines/desktop-*.json (currently desktop-2.2553.1), and" },
      { path: "docs/README.md", text: "the live values are `baselines/desktop-*.json` (currently `desktop-2.2553.1`)" },
    ]);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatch(/^llms\.txt:2 /);
    expect(errors[1]).toMatch(/^docs\/README\.md:1 /);
  });

  it("rejects a pin that wraps onto the next line", () => {
    expect(checkBaselinePinClaims([TEMPLATE_OK, { path: "a.md", text: "(currently\n  `desktop-2.9939.2`)" }])).toHaveLength(1);
  });

  it("rejects a pin even when its value is today's, because the next sync makes it stale", () => {
    expect(checkBaselinePinClaims([TEMPLATE_OK, { path: "a.md", text: "currently `desktop-2.9939.2`" }])).toHaveLength(1);
  });

  it("exempts the frozen spawn-contract doc and nothing else under docs/", () => {
    const pin = "currently `desktop-1.12603.1`";
    expect(checkBaselinePinClaims([TEMPLATE_OK, { path: "docs/cowork-spawn-contract-1.12603.1.md", text: pin }])).toEqual([]);
    expect(checkBaselinePinClaims([TEMPLATE_OK, { path: "docs/cowork-spawn-contract-notes/x.md", text: pin }])).toHaveLength(1);
  });

  it("exempts dated decision records under docs/decisions/, which are history like CHANGELOG.md", () => {
    const pin = "At the time of this decision the baseline was currently `desktop-2.2553.1`.";
    expect(checkBaselinePinClaims([TEMPLATE_OK, { path: "docs/decisions/2026-07-07-some-decision.md", text: pin }])).toEqual([]);
    expect(checkBaselinePinClaims([TEMPLATE_OK, { path: "docs/decisions-notes.md", text: pin }])).toHaveLength(1);
  });

  it("rejects the real historical template placeholders", () => {
    const errors = checkBaselinePinClaims([
      {
        path: ".github/ISSUE_TEMPLATE/bug_report.yml",
        text: 'placeholder: "3.6.0 (npm -g)"\nplaceholder: "desktop-2.2553.1 / app 2.2553.1 / agent 2.1.275"\n',
      },
    ]);
    expect(errors.map((e) => e.split(" ")[0])).toEqual([
      ".github/ISSUE_TEMPLATE/bug_report.yml:1",
      ".github/ISSUE_TEMPLATE/bug_report.yml:2",
      ".github/ISSUE_TEMPLATE/bug_report.yml:2",
      ".github/ISSUE_TEMPLATE/bug_report.yml:2",
    ]);
  });

  it("fails when no issue template was scanned, rather than passing vacuously", () => {
    expect(checkBaselinePinClaims([{ path: "README.md", text: "" }])).toEqual([
      expect.stringContaining("no .github/ISSUE_TEMPLATE/ file was scanned"),
    ]);
  });
});
