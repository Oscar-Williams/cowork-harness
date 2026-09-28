import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { replayCassette, redactCassette, redactionRewroteNegativeToolInputs, type Cassette } from "../src/run/cassette.js";
import { loadRedactionPolicy } from "../src/redact.js";
import type { Scenario } from "../src/types.js";

// THE HAZARD. A committed cassette is redacted by default, and redaction rewrites the frozen tool_use
// inputs. A NEGATIVE input check naming a literal the policy rewrites (a home path) then looks for bytes
// that are gone and would pass VACUOUSLY on replay — the CI lane — while it FAILS live. The positive form
// merely fails on replay (loud). These pin every guard: replay must not pass, and `record` must say why.
//
// The cassette is built directly with `redactCassette` — `record` would refuse a run whose negative check
// failed live before it ever reached redaction, so recording one is not how the hazard is reached in
// practice (it is reached by `--allow-failing`, by a later edit replayed with `--assert-from`, or by a
// regex the policy itself rewrites).

const POLICY = loadRedactionPolicy([resolve(".")]); // the repo's own .cowork-redact.json
const NEG = { tool_not_called: { tool: "Bash", input: { command: "rm\\s+-rf\\s+/Users/acme" } } };

const line = (o: unknown) => JSON.stringify(o);
const INIT = line({ type: "system", subtype: "init", tools: ["Bash"] });
const BASH = line({
  type: "assistant",
  message: {
    role: "assistant",
    content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "rm -rf /Users/acme/project/tmp" } }],
  },
});
const RESULT = line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "b1", content: "" }] } });
const DONE = line({ type: "result", subtype: "success", is_error: false });

function cassette(assert: Record<string, unknown>[]): Cassette {
  return {
    scenario: {
      name: "redaction-hazard",
      baseline: "latest",
      session: "(inline)",
      fidelity: "container",
      prompt: "clean up",
      answers: [],
      expect_denied: [],
      assert,
    } as unknown as Scenario,
    events: [INIT, BASH, RESULT, DONE],
    controlOut: [],
  } as unknown as Cassette;
}

const verdictOf = async (c: Cassette) => (await replayCassette(c, [])).assertions.find((a) => "tool_not_called" in a.assertion)!;

describe("negative object form over a redacted cassette", () => {
  it("sanity: the policy really rewrites the command, and the UNREDACTED replay fails the negative", async () => {
    expect(POLICY.patterns.length).toBeGreaterThan(0);
    const red = redactCassette(cassette([NEG]), POLICY);
    expect(red.events[1]).toContain("[REDACTED:");
    expect((await verdictOf(cassette([NEG]))).pass).toBe(false);
  });

  it("replay of the redacted cassette does NOT pass (frozen regex rewritten by the same policy)", async () => {
    const red = redactCassette(cassette([NEG]), POLICY);
    const v = await verdictOf(red);
    expect(v.pass).toBe(false);
    expect(v.message).toMatch(/evidence unavailable/);
  });

  it("replay with an UNREDACTED regex against the redacted stream (the --assert-from shape) does NOT pass", async () => {
    const red = redactCassette(cassette([NEG]), POLICY);
    const reasserted = { ...red, scenario: { ...red.scenario, assert: [NEG] } } as Cassette;
    const v = await verdictOf(reasserted);
    expect(v.pass).toBe(false);
    expect(v.message).toMatch(/evidence unavailable/);
  });

  it("a negative whose literal redaction does NOT touch still passes on the redacted cassette", async () => {
    const clean = { tool_not_called: { tool: "Bash", input: { command: "git\\s+push" } } };
    const red = redactCassette(cassette([clean]), POLICY);
    expect((await verdictOf(red)).pass).toBe(true);
  });
});

describe("record-time warning (the exact guard)", () => {
  it("names the assertion whose pre-redaction match redaction rewrote, and the regex the policy rewrote", () => {
    const base = cassette([NEG]);
    const red = redactCassette(base, POLICY);
    const findings = redactionRewroteNegativeToolInputs(base, red);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.join("\n")).toMatch(/tool_not_called\.input\.command/);
    expect(findings.join("\n")).toMatch(/b1/);
  });

  it("is silent when redaction leaves every negative input regex and its matches alone", () => {
    const clean = cassette([{ tool_not_called: { tool: "Bash", input: { command: "git\\s+push" } } }]);
    expect(redactionRewroteNegativeToolInputs(clean, redactCassette(clean, POLICY))).toEqual([]);
  });

  it("ignores positive forms and string forms", () => {
    const c = cassette([{ tool_called: { tool: "Bash", input: { command: "/Users/acme" } } }, { tool_not_called: "Write" }]);
    expect(redactionRewroteNegativeToolInputs(c, redactCassette(c, POLICY))).toEqual([]);
  });
});
