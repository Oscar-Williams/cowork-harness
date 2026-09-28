import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { replayCassette, type Cassette } from "../src/run/cassette.js";

// The scope classifier on a REAL recorded stream: a container-tier recording in which the main agent
// dispatched a general-purpose sub-agent (Agent) and the sub-agent ran `python3 --version` (Bash, with
// parent_tool_use_id = the dispatch). The synthetic cases in tool-call-object-form.test.ts pin the
// classifier's logic; this pins that the agent's real frames reach it in the shape it expects.
const DIR = resolve("test/fixtures/tool-call-dispatch");
const FIXTURE = JSON.parse(readFileSync(resolve(DIR, "dispatch-shell.cassette.json"), "utf8")) as Cassette;
const withAssert = (assert: unknown[]): Cassette => ({ ...FIXTURE, scenario: { ...FIXTURE.scenario, assert } }) as Cassette;
const PY = { command: "python3?\\s+--version" };

describe("real stream: a sub-agent's shell call", () => {
  it("the fixture replays green as recorded, and is stamped v13", async () => {
    expect(FIXTURE.cassetteVersion).toBe(13);
    const r = await replayCassette(FIXTURE, [], { cassetteDir: DIR });
    expect(r.assertions.every((a) => a.pass)).toBe(true);
  });

  it("arms: the re-drive yields a non-empty candidate list with a parented Bash under a recorded dispatch", async () => {
    const r = await replayCassette(withAssert([{ result: "success" }]), [], { cassetteDir: DIR });
    const bash = r.toolCalls?.filter((c) => c.name === "Bash") ?? [];
    expect(bash.length).toBeGreaterThan(0);
    expect(bash.every((c) => c.origin === "subagent")).toBe(true);
    const dispatchIds = new Set((r.subagents ?? []).map((s) => s.toolUseId));
    expect(bash.every((c) => c.parentToolUseId !== undefined && dispatchIds.has(c.parentToolUseId))).toBe(true);
    expect(r.toolCalls?.find((c) => c.name === "Agent")?.origin).toBe("main");
  });

  it("scope: subagent passes, scope: main fails and names the subagent-scope match, scope: any passes", async () => {
    const r = await replayCassette(
      withAssert([
        // The recorded command was `python3 --version; python --version`: the second half exits 127 (no
        // `python` on the image), so the PAIRED result is an error that still printed the version.
        { tool_called: { tool: "Bash", input: PY, scope: "subagent", result: { is_error: true, matches: "Python 3\\.\\d+" } } },
        { tool_called: { tool: "Bash", input: PY } },
        { tool_called: { tool: "Bash", input: PY, scope: "any" } },
        { tool_called: { tool: "Bash", input: PY, scope: "subagent", subagent_type: "general-purpose" } },
        { tool_called: { tool: "Bash", input: PY, scope: "subagent", subagent_type: "researcher" } },
      ]),
      [],
      { cassetteDir: DIR },
    );
    const [sub, main, any, typed, wrongType] = r.assertions;
    expect(sub.pass).toBe(true);
    expect(main.pass).toBe(false);
    expect(main.message).toMatch(/1 matching call in scope subagent/);
    expect(any.pass).toBe(true);
    expect(typed.pass).toBe(true);
    expect(wrongType.pass).toBe(false);
  });

  it("the sub-agent's tool_result reaches the parent stream and pairs by toolUseId", async () => {
    const r = await replayCassette(
      withAssert([{ tool_called: { tool: "Bash", input: PY, scope: "subagent", result: { is_error: false } } }]),
      [],
      {
        cassetteDir: DIR,
      },
    );
    expect(r.assertions[0].pass).toBe(false);
    expect(r.assertions[0].message).toMatch(/result mismatch, paired/); // paired, not "unpaired"
  });

  it("the string form cannot see the sub-agent's call — the gap the object form closes", async () => {
    const r = await replayCassette(withAssert([{ tool_called: "Bash" }, { tool_not_called: "Bash" }]), [], { cassetteDir: DIR });
    expect(r.assertions[0].pass).toBe(false);
    expect(r.assertions[1].pass).toBe(true); // a vacuous green for "no Bash ran anywhere"
    const scoped = await replayCassette(withAssert([{ tool_not_called: { tool: "Bash", scope: "any" } }]), [], { cassetteDir: DIR });
    expect(scoped.assertions[0].pass).toBe(false);
  });
});
