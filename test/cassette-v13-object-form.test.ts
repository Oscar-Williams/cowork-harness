import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CASSETTE_VERSION, requiredVersionFor, readCassette } from "../src/run/cassette.js";
import { ScenarioObject } from "../src/types.js";

// An object-form tool_called / tool_not_called changes what a replay verdict MEANS (it reads inputs,
// scope and paired results a v12 reader has never heard of), so the cassette must lift its stamp to v13.
// Without the lift, an older CLI rejects the frozen assertion as "unrecognized … Fix the assertion, or
// re-record" — the wrong remedy, and the `--best-effort-future-cassette` path is unreachable. With it, an
// older CLI says "cassette format too new; upgrade", which is the truth.

const parse = (assert: unknown[]) => ScenarioObject.parse({ prompt: "x", assert });

describe("the `assert` entry of the stamp is value-aware", () => {
  it("an object-form tool_called lifts the stamp to 13", () => {
    expect(requiredVersionFor(parse([{ tool_called: { tool: "Bash", input: { command: "x" } } }]))).toBe(13);
  });
  it("an object-form tool_not_called lifts the stamp to 13 — even the {tool} shorthand, which an older reader cannot parse", () => {
    expect(requiredVersionFor(parse([{ tool_not_called: { tool: "Bash" } }]))).toBe(13);
  });
  it("string-form scenarios keep stamping 12", () => {
    expect(requiredVersionFor(parse([{ tool_called: "Bash" }, { tool_not_called: "Write" }, { result: "success" }]))).toBe(12);
    expect(requiredVersionFor(parse([]))).toBe(12);
  });
  it("a loose on-disk scenario (as rehash reads it) is judged the same way", () => {
    expect(requiredVersionFor({ prompt: "x", assert: [{ tool_called: { tool: "Bash" } }] })).toBe(13);
    expect(requiredVersionFor({ prompt: "x", assert: "not-an-array" })).toBe(12);
  });
  it("this build writes and reads v13", () => {
    expect(CASSETTE_VERSION).toBe(13);
  });
});

describe("a v12-only reader's view of a v13 cassette", () => {
  // Simulated by stamping one version ABOVE this build's max: the reader then takes exactly the
  // future-cassette path a v12 build takes for a v13 cassette.
  const cassette = (version: number) =>
    JSON.stringify({
      cassetteVersion: version,
      scenario: {
        name: "s",
        baseline: "latest",
        session: "(inline)",
        fidelity: "container",
        prompt: "hi",
        answers: [],
        expect_denied: [],
        assert: [{ tool_called: { tool: "Bash", inputz: "a key from the future" } }],
      },
      events: [],
      controlOut: [],
    });

  const readCassetteFromString = (text: string) => {
    const f = join(mkdtempSync(join(tmpdir(), "cwh-v13-")), "c.cassette.json");
    writeFileSync(f, text);
    return readCassette(f);
  };

  it("tolerates (warns on) an unrecognized assertion in a FUTURE cassette instead of demanding a re-record", () => {
    const r = readCassetteFromString(cassette(CASSETTE_VERSION + 1));
    expect("error" in r ? r.error : "").toBe("");
  });

  it("a CURRENT-version cassette with an unrecognized assertion is still refused", () => {
    const r = readCassetteFromString(cassette(CASSETTE_VERSION));
    expect("error" in r ? r.error : "").toMatch(/unrecognized assertion/);
  });
});
