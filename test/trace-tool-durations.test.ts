import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildToolDurations, formatToolDurations } from "../src/run/trace-view.js";

// `trace --view tool-durations`: the basis header, `--scope` (reusing the run's own origin
// classification from result.json's toolCalls — never a second classifier), and `--per-call`.

const HEADER = JSON.stringify({ v: 1, startedAtWall: new Date(0).toISOString(), startedAtMono: "0" });
const use = (seq: number, ts: number, id: string, name: string, parent?: string) =>
  JSON.stringify({ seq, ts, line: seq, type: "tool_use", toolUseId: id, name, ...(parent ? { parentToolUseId: parent } : {}) });
const res = (seq: number, ts: number, id: string) =>
  JSON.stringify({ seq, ts, line: seq, type: "tool_result", toolUseId: id, isError: false });

// main: Agent d1 (0→500), Read r1 (10→30); sub-agent under d1: Bash b1 (100→400); main Bash b2 never pairs.
const TIMELINE = [
  HEADER,
  use(0, 0, "d1", "Agent"),
  use(1, 10, "r1", "Read"),
  res(2, 30, "r1"),
  use(3, 100, "b1", "Bash", "d1"),
  res(4, 400, "b1"),
  res(5, 500, "d1"),
  use(6, 600, "b2", "Bash"),
];
const TOOL_CALLS = [
  { toolUseId: "d1", name: "Agent", input: {}, origin: "main" },
  { toolUseId: "r1", name: "Read", input: {}, origin: "main" },
  { toolUseId: "b1", name: "Bash", input: {}, origin: "subagent", parentToolUseId: "d1" },
  { toolUseId: "b2", name: "Bash", input: {}, origin: "main" },
];

function runDir(opts: { timeline?: string[]; result?: object | null }): string {
  const dir = mkdtempSync(join(tmpdir(), "cwh-durations-"));
  writeFileSync(join(dir, "events.jsonl"), "");
  if (opts.timeline) writeFileSync(join(dir, "timeline.jsonl"), opts.timeline.join("\n") + "\n");
  if (opts.result) {
    mkdirSync(join(dir, "turns", "1"), { recursive: true });
    writeFileSync(join(dir, "turns", "1", "result.json"), JSON.stringify(opts.result));
  }
  return join(dir, "events.jsonl");
}

describe("trace --view tool-durations: basis", () => {
  it("names the basis in the view and in the rendered text", () => {
    const v = buildToolDurations(runDir({ timeline: TIMELINE }));
    expect(v.basis).toBe("wall_gap");
    const text = formatToolDurations(v);
    expect(text).toMatch(/wall gap from tool_use to tool_result/);
    expect(text).toMatch(/permission/);
    expect(text).toMatch(/Agent\/Task entry spans its whole sub-agent run/);
  });

  it("shows paired and unpaired counts per tool", () => {
    const v = buildToolDurations(runDir({ timeline: TIMELINE }));
    expect(v.durations.Bash).toEqual({ calls: 1, totalMs: 300, maxMs: 300, unpaired: 1 });
    expect(formatToolDurations(v)).toMatch(/Bash\b.*1 paired, 1 unpaired/);
  });

  it("a corrupt timeline is reported unavailable, not folded partially (the RunResult sites refuse it too)", () => {
    const v = buildToolDurations(runDir({ timeline: [...TIMELINE, "{not json"] }));
    expect(v.available).toBe(false);
    expect(v.durations).toEqual({});
    expect(formatToolDurations(v)).toMatch(/malformed/);
  });
});

describe("trace --view tool-durations: --scope", () => {
  const result = { toolCalls: TOOL_CALLS };

  it("default scope any: every paired call, main and sub-agent", () => {
    const v = buildToolDurations(runDir({ timeline: TIMELINE, result }));
    expect(v.scope).toBe("any");
    expect(Object.keys(v.durations).sort()).toEqual(["Agent", "Bash", "Read"]);
  });

  it("--scope main excludes a sub-agent's (parented) call", () => {
    const v = buildToolDurations(runDir({ timeline: TIMELINE, result }), { scope: "main" });
    expect(v.durations.Bash).toEqual({ calls: 0, totalMs: 0, maxMs: 0, unpaired: 1 });
    expect(v.durations.Read?.calls).toBe(1);
    expect(v.durations.Agent?.calls).toBe(1);
  });

  it("--scope subagent keeps only the sub-agent's call", () => {
    const v = buildToolDurations(runDir({ timeline: TIMELINE, result }), { scope: "subagent" });
    expect(v.durations).toEqual({ Bash: { calls: 1, totalMs: 300, maxMs: 300, unpaired: 0 } });
  });

  it("a narrowed scope with no result.json is unavailable — never a silent render of every call", () => {
    const v = buildToolDurations(runDir({ timeline: TIMELINE }), { scope: "main" });
    expect(v.available).toBe(false);
    expect(v.durations).toEqual({});
    expect(formatToolDurations(v)).toMatch(/--scope main needs/);
  });

  it("a narrowed scope on a result.json that predates toolCalls is unavailable", () => {
    const v = buildToolDurations(runDir({ timeline: TIMELINE, result: { scenario: "x" } }), { scope: "subagent" });
    expect(v.available).toBe(false);
  });

  it("a timeline call the run never classified is excluded from a narrowed scope AND counted", () => {
    const v = buildToolDurations(runDir({ timeline: TIMELINE, result: { toolCalls: TOOL_CALLS.slice(0, 3) } }), { scope: "main" });
    expect(v.unclassified).toBe(1); // b2
    expect(v.durations.Bash).toBeUndefined();
    expect(formatToolDurations(v)).toMatch(/1 call\(s\) absent from toolCalls/);
  });
});

describe("trace --view tool-durations: --per-call", () => {
  it("one row per call in stream order; unpaired calls are rows with no duration", () => {
    const v = buildToolDurations(runDir({ timeline: TIMELINE, result: { toolCalls: TOOL_CALLS } }), { perCall: true });
    expect(v.calls?.map((c) => [c.toolUseId, c.name, c.durationMs, c.origin])).toEqual([
      ["d1", "Agent", 500, "main"],
      ["r1", "Read", 20, "main"],
      ["b1", "Bash", 300, "subagent"],
      ["b2", "Bash", undefined, "main"],
    ]);
    const paired = v.calls!.filter((c) => c.durationMs !== undefined);
    expect(paired.length).toBe(Object.values(v.durations).reduce((n, d) => n + d.calls, 0));
    const text = formatToolDurations(v);
    expect(text).toMatch(/b1\b.*Bash.*0\.3s/);
    expect(text).toMatch(/b2\b.*Bash.*no result/);
  });

  it("--per-call honours --scope", () => {
    const v = buildToolDurations(runDir({ timeline: TIMELINE, result: { toolCalls: TOOL_CALLS } }), { perCall: true, scope: "subagent" });
    expect(v.calls?.map((c) => c.toolUseId)).toEqual(["b1"]);
  });

  it("without --per-call there are no rows", () => {
    expect(buildToolDurations(runDir({ timeline: TIMELINE })).calls).toBeUndefined();
  });
});

// The CLI surface — spawns the BUILT CLI (no agent spawn; trace only reads files).
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
const CLI = resolve("dist/cli.js");
describe.skipIf(!existsSync(CLI))("trace CLI: --scope / --per-call", () => {
  const trace = (...args: string[]) => spawnSync("node", [CLI, "trace", ...args], { encoding: "utf8" });
  const f = () => runDir({ timeline: TIMELINE, result: { toolCalls: TOOL_CALLS } });

  it("--view tool-durations --scope subagent --per-call --output-format json carries basis, scope and rows", () => {
    const r = trace(f(), "--view", "tool-durations", "--scope", "subagent", "--per-call", "--output-format", "json");
    expect(r.status, r.stderr).toBe(0);
    const payload = JSON.parse(r.stdout);
    const body = payload.results?.[0] ?? payload;
    expect(body.basis).toBe("wall_gap");
    expect(body.scope).toBe("subagent");
    expect(body.durations).toEqual({ Bash: { calls: 1, totalMs: 300, maxMs: 300, unpaired: 0 } });
    expect(body.calls.map((c: { toolUseId: string }) => c.toolUseId)).toEqual(["b1"]);
  });

  it("an unknown --scope value is a usage error (exit 2)", () => {
    expect(trace(f(), "--view", "tool-durations", "--scope", "all").status).toBe(2);
  });

  it("--scope / --per-call with another view is a usage error, not silently ignored", () => {
    expect(trace(f(), "--view", "tools", "--scope", "main").status).toBe(2);
    expect(trace(f(), "--per-call").status).toBe(2);
  });
});

describe.skipIf(!existsSync(CLI))("trace CLI: --scope=<v> equals form", () => {
  it("is honoured, not silently dropped", () => {
    const f = runDir({ timeline: TIMELINE, result: { toolCalls: TOOL_CALLS } });
    const r = spawnSync("node", [CLI, "trace", f, "--view", "tool-durations", "--scope=subagent", "--output-format", "json"], {
      encoding: "utf8",
    });
    expect(r.status, r.stderr).toBe(0);
    const payload = JSON.parse(r.stdout);
    expect((payload.results?.[0] ?? payload).scope).toBe("subagent");
  });
});

describe("trace --view tool-durations: unknown-origin calls under a narrowed scope", () => {
  // Read r1 (main); Skill s1 whose parent "ghost" is not a recorded dispatch (unknown); Bash b1 under s1 (unknown).
  const tl = [
    HEADER,
    use(0, 0, "r1", "Read"),
    res(1, 5, "r1"),
    use(2, 10, "s1", "Skill", "ghost"),
    res(3, 20, "s1"),
    use(4, 30, "b1", "Bash", "s1"),
    res(5, 40, "b1"),
  ];
  const calls = [
    { toolUseId: "r1", name: "Read", input: {}, origin: "main" },
    { toolUseId: "s1", name: "Skill", input: {}, origin: "unknown", parentToolUseId: "ghost" },
    { toolUseId: "b1", name: "Bash", input: {}, origin: "unknown", parentToolUseId: "s1" },
  ];

  it("--scope main counts them in unknownOrigin (not silently dropped) and says to use --scope any", () => {
    const v = buildToolDurations(runDir({ timeline: tl, result: { toolCalls: calls } }), { scope: "main" });
    expect(v.durations).toEqual({ Read: { calls: 1, totalMs: 5, maxMs: 5, unpaired: 0 } });
    expect(v.unknownOrigin).toBe(2);
    expect(v.unclassified).toBe(0);
    const text = formatToolDurations(v);
    expect(text).toMatch(/2 call\(s\) with unknown origin \(parent not a recorded dispatch\) excluded; use --scope any/);
  });

  it("--scope subagent counts them too; --scope any keeps them and reports no unknownOrigin exclusion", () => {
    expect(buildToolDurations(runDir({ timeline: tl, result: { toolCalls: calls } }), { scope: "subagent" }).unknownOrigin).toBe(2);
    const any = buildToolDurations(runDir({ timeline: tl, result: { toolCalls: calls } }));
    expect(any.unknownOrigin).toBeUndefined();
    expect(Object.keys(any.durations).sort()).toEqual(["Bash", "Read", "Skill"]);
  });

  it("the unclassified line names what it counts: calls absent from toolCalls", () => {
    const v = buildToolDurations(runDir({ timeline: tl, result: { toolCalls: calls.slice(0, 1) } }), { scope: "main" });
    expect(v.unclassified).toBe(2);
    expect(formatToolDurations(v)).toMatch(/2 call\(s\) absent from toolCalls/);
  });
});
