import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { replayCassette, type Cassette } from "../src/run/cassette.js";

// The object form of tool_called / tool_not_called on the two lanes that do not run an agent: replay
// (re-drives Run over frozen events, so `toolCalls` is re-derived) and verify-run (reads
// result.json's `toolCalls`, never re-derives it). Plus the equivalence `{tool: X}` ≡ `"X"` on both.

const PDF = "examples/replays/example-pdf-skill.cassette.json";
const pdfWith = (assert: unknown[]): Cassette => {
  const c = JSON.parse(readFileSync(PDF, "utf8")) as Cassette;
  return { ...c, scenario: { ...c.scenario, assert } } as Cassette;
};
const byKey = (r: Awaited<ReturnType<typeof replayCassette>>, i: number) => r.assertions[i];

describe("replay over a REAL recorded stream (example-pdf-skill: one main-agent Bash)", () => {
  it("arms: the re-drive yields a non-empty candidate list", async () => {
    const r = await replayCassette(pdfWith([{ result: "success" }]), [], { cassetteDir: resolve("examples/replays") });
    expect(r.toolCalls?.filter((c) => c.name === "Bash").length).toBeGreaterThan(0);
    expect(r.toolCalls?.every((c) => c.origin === "main")).toBe(true);
  });

  it("scope: main passes on the real Bash command; scope: subagent fails and names the main-scope match", async () => {
    const r = await replayCassette(
      pdfWith([
        { tool_called: { tool: "Bash", input: { command: "ls\\s+-la\\s+\\S*/uploads" } } },
        { tool_called: { tool: "Bash", input: { command: "ls\\s+-la\\s+\\S*/uploads" }, scope: "subagent" } },
        { tool_called: { tool: "Write", input: { file_path: "outputs/actions\\.md$" }, result: { is_error: false } } },
        { tool_not_called: { tool: "Bash", input: { command: "rm\\s+-rf" }, scope: "any" } },
      ]),
      [],
      { cassetteDir: resolve("examples/replays") },
    );
    expect(byKey(r, 0).pass).toBe(true);
    expect(byKey(r, 1).pass).toBe(false);
    expect(byKey(r, 1).message).toMatch(/1 matching call in scope main/);
    expect(byKey(r, 2).pass).toBe(true);
    expect(byKey(r, 3).pass).toBe(true);
  });

  it('{tool: X} ≡ "X" on replay', async () => {
    const r = await replayCassette(
      pdfWith([
        { tool_called: "Bash" },
        { tool_called: { tool: "Bash" } },
        { tool_not_called: "WebFetch" },
        { tool_not_called: { tool: "WebFetch" } },
      ]),
      [],
      { cassetteDir: resolve("examples/replays") },
    );
    expect(byKey(r, 0).pass).toBe(byKey(r, 1).pass);
    expect(byKey(r, 2).pass).toBe(byKey(r, 3).pass);
    expect(byKey(r, 1).pass).toBe(true);
  });
});

// ---- verify-run ----------------------------------------------------------------------------------

const CLI = resolve("dist/cli.js");

function keptRun(withToolCalls: boolean): string {
  const root = mkdtempSync(join(tmpdir(), "cwh-vr-tc-"));
  const workDir = join(root, "work", "session", "mnt");
  mkdirSync(join(workDir, "outputs"), { recursive: true });
  const result: Record<string, unknown> = {
    scenario: "smoke",
    fidelity: "container",
    baseline: "desktop-1.13576.1",
    result: "success",
    decisions: [],
    toolCounts: { Bash: 1 },
    gateDeliveries: [],
    egress: [],
    assertions: [],
    subagents: [],
    outDir: root,
    workDir,
    durationMs: 1,
    scan: { outputsDeletes: [], hostPathLeaked: false, selfHealRan: false },
    toolResults: [{ toolUseId: "b1", isError: false, text: "OK", assertText: "OK" }],
  };
  if (withToolCalls)
    result.toolCalls = [{ toolUseId: "b1", name: "Bash", input: { command: { text: "node fetch-lesson.js 129" } }, origin: "main" }];
  const t1 = join(root, "turns", "1");
  mkdirSync(t1, { recursive: true });
  writeFileSync(join(t1, "result.json"), JSON.stringify(result, null, 2));
  writeFileSync(join(t1, "run.jsonl"), JSON.stringify({ t: "run", scenario: "smoke" }) + "\n");
  writeFileSync(join(t1, "trace.json"), JSON.stringify({ questions: [], steps: ["Bash"] }));
  return root;
}

function verifyRun(runDir: string, assertYaml: string) {
  const f = join(runDir, "scenario.yaml");
  writeFileSync(f, `name: smoke\nprompt: do the thing\nfidelity: container\nassert:\n${assertYaml}`);
  const r = spawnSync("node", [CLI, "verify-run", runDir, f], { encoding: "utf8", cwd: mkdtempSync(join(tmpdir(), "cwh-vrcwd-")) });
  return { code: r.status, text: (r.stderr || "") + (r.stdout || "") };
}

describe.skipIf(!existsSync(CLI))("verify-run reads result.json's toolCalls — never re-derives them", () => {
  it("passes the object form when toolCalls is present", () => {
    const { code, text } = verifyRun(
      keptRun(true),
      "  - tool_called: { tool: Bash, input: { command: 'fetch-lesson\\.js\\s+129' }, result: { matches: '^OK' } }\n",
    );
    expect(text).toContain("verify-run: all");
    expect(code).toBe(0);
  });

  it("an OLD result.json without toolCalls: the object form is evidence-unavailable, both directions", () => {
    for (const a of [
      "  - tool_called: { tool: Bash, input: { command: x } }\n",
      "  - tool_not_called: { tool: Bash, input: { command: 'rm\\s+-rf' } }\n",
    ]) {
      const { code, text } = verifyRun(keptRun(false), a);
      expect(code, text).not.toBe(0);
      expect(text).toMatch(/evidence unavailable: tool calls absent from result\.json/);
    }
  });

  it('{tool: X} ≡ "X" on verify-run, INCLUDING an old result.json without toolCalls', () => {
    for (const withTc of [true, false]) {
      const s = verifyRun(keptRun(withTc), "  - tool_called: Bash\n");
      const o = verifyRun(keptRun(withTc), "  - tool_called: { tool: Bash }\n");
      expect(o.code).toBe(s.code);
      expect(o.code).toBe(0);
    }
  });
});
