import { describe, it, expect } from "vitest";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { replayCassette, type Cassette } from "../src/run/cassette.js";
import { buildChatResult } from "../src/run/chat-result.js";
import { toolDurationFields } from "../src/run/timeline-fold.js";
import type { RunRecord } from "../src/run/run.js";

// `toolDurationsBasis` names what `toolDurations` measures. It must be present exactly when
// `toolDurations` is — a basis over no data, or data with no basis, would each mislead — on every lane
// that assembles a RunResult: live (execute.ts ×2), replay (cassette.ts), chat (chat-result.ts). The
// live sites cannot run here (no spawn), so they share the one helper this file pins.

describe("toolDurationFields — the single derivation every RunResult site uses", () => {
  it("no timeline → neither field (the fold never ran, so there is no basis to state)", () => {
    expect(toolDurationFields(undefined)).toEqual({ toolDurations: undefined, toolDurationsBasis: undefined });
  });

  it("a timeline → the fold plus basis wall_gap, even when the fold is empty", () => {
    expect(toolDurationFields([])).toEqual({ toolDurations: {}, toolDurationsBasis: "wall_gap" });
  });
});

describe("replay lane (a real recorded stream)", () => {
  const DIR = resolve("test/fixtures/tool-call-dispatch");
  const FIXTURE = JSON.parse(readFileSync(resolve(DIR, "dispatch-shell.cassette.json"), "utf8")) as Cassette;

  it("states the basis, carries an unpaired count on every tool, and pairs the sub-agent's Bash call", async () => {
    expect(FIXTURE.timeline?.length).toBeGreaterThan(0); // arms: the fold has real input
    const r = await replayCassette(FIXTURE, [], { cassetteDir: DIR });
    expect(r.toolDurationsBasis).toBe("wall_gap");
    const d = r.toolDurations!;
    expect(Object.keys(d).length).toBeGreaterThan(0);
    for (const [name, v] of Object.entries(d)) expect(typeof v.unpaired, name).toBe("number");
    expect(d.Bash?.calls).toBeGreaterThan(0);
  });

  it("the id-less synthetic MCP echoes in a real timeline are not counted as unpaired calls", async () => {
    // Arming: the recorded timeline really carries id-less tool_use events (the MCP handshake echoes).
    const echoes = (FIXTURE.timeline ?? []).filter((e) => e.type === "tool_use" && !e.toolUseId);
    expect(echoes.length).toBeGreaterThan(0);
    const r = await replayCassette(FIXTURE, [], { cassetteDir: DIR });
    for (const e of echoes) expect(r.toolDurations?.[(e as { name: string }).name]).toBeUndefined();
    expect(Object.values(r.toolDurations ?? {}).every((d) => typeof d.unpaired === "number")).toBe(true); // the writer emits it; ?? below is for the type only
    expect(Object.values(r.toolDurations ?? {}).reduce((n, d) => n + (d.unpaired ?? 0), 0)).toBe(0);
  });

  it("a cassette with no frozen timeline → neither field", async () => {
    const r = await replayCassette({ ...FIXTURE, timeline: undefined } as Cassette, [], { cassetteDir: DIR });
    expect(r.toolDurations).toBeUndefined();
    expect(r.toolDurationsBasis).toBeUndefined();
  });
});

describe("chat lane", () => {
  const record = {
    runId: "chat",
    modelFallbacks: [],
    result: "success",
    initTools: [],
    transcript: "",
    toolsCalled: new Set(),
    toolCounts: {},
    referencesAccessed: [],
    filesRead: [],
    subagentTools: new Set(),
    subagents: [],
    questions: [],
    gateOptions: [],
    decisions: [],
    permissiveAutoAllow: [],
    unanswered: [],
    toolResults: [],
    gateAnswers: [],
    gateDeliveries: [],
    skillsInvoked: [],
    models: [],
    thinking: [],
    thinkingElided: 0,
    toolErrors: {},
    redundantToolCalls: [],
    tasks: new Map(),
    context: { tools: [], mcpServers: [] },
    contextEvents: [],
    mcpErrors: [],
    hookEvents: [],
    fileToolAttempts: [],
    toolCalls: [],
    pathDenials: [],
    presentedFiles: [],
    presentFilesCalls: 0,
    webSearches: [],
    infraErrors: [],
    evidenceErrors: { taskTracking: 0, webSearchParse: 0, presentFilesMalformed: 0 },
  } as unknown as RunRecord;
  const opts = (outDir: string) => ({
    scenario: "(chat)",
    prompt: "hi",
    fidelity: "container" as const,
    baseline: "1.0",
    outDir,
    workRoot: join(outDir, "work"),
    userVisibleRoots: ["outputs"],
    readonlyFolderRoots: [],
    egress: [],
    durationMs: 5,
    turn: 1,
  });

  it("a clean timeline → basis wall_gap and the unpaired call counted", () => {
    const dir = mkdtempSync(join(tmpdir(), "chat-durations-"));
    const header = JSON.stringify({ v: 1, startedAtWall: new Date(0).toISOString(), startedAtMono: "0" });
    const lines = [header, JSON.stringify({ seq: 0, ts: 0, line: 0, type: "tool_use", toolUseId: "t1", name: "Bash" })];
    writeFileSync(join(dir, "timeline.jsonl"), lines.join("\n") + "\n");
    const r = buildChatResult(record, opts(dir));
    expect(r.toolDurationsBasis).toBe("wall_gap");
    expect(r.toolDurations).toEqual({ Bash: { calls: 0, totalMs: 0, maxMs: 0, unpaired: 1 } });
  });

  it("no timeline → neither field", () => {
    const r = buildChatResult(record, opts(mkdtempSync(join(tmpdir(), "chat-durations-"))));
    expect(r.toolDurations).toBeUndefined();
    expect(r.toolDurationsBasis).toBeUndefined();
  });
});

import type { RunResult } from "../src/types.js";
describe("RunResult.toolDurations type admits an older result file", () => {
  it("an entry without `unpaired` (written before it existed, passed through by verify-run) type-checks", () => {
    // Compile-time check (tsc -p tsconfig.test.json): the reader type must not claim a key old files lack.
    const legacy: RunResult["toolDurations"] = { Bash: { calls: 1, totalMs: 10, maxMs: 10 } };
    expect(legacy?.Bash.unpaired).toBeUndefined();
  });
});
