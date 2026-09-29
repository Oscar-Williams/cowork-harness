import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as execute from "../src/run/execute.js";
import * as provenance from "../src/run/input-host-paths.js";
import { computeVerdict } from "../src/run/verdict.js";
import type { RunResult } from "../src/types.js";
import type { LaunchPlan, Mount } from "../src/session.js";

// At container/microvm fidelity the verdict default-fails `host_path_leak` when model-visible text carries
// a host-root path. But a user who uploads or connects a file that itself contains `/Users/…` paths — a kept
// run dir's result.json, a log, a config — failed every run the moment the agent read or quoted it, though
// nothing leaked from the harness: real Cowork would show the same bytes. A host path is now exempt when it
// came VERBATIM from the scenario's own inputs (captured before the agent ran), unless it names a location
// the harness created for THIS run. Synthetic usernames only.

const { scanEvents, hostPathLeaked } = execute;
const hostPathTokens = (t: string): string[] => (execute as any).hostPathTokens(t);
const capture = (plan: Partial<LaunchPlan>, mntHost: string, outDir: string): void =>
  (provenance as any).captureInputHostPathCorpus(plan, mntHost, outDir);
const readCorpus = (outDir: string): Set<string> => (provenance as any).readInputHostPathCorpus?.(outDir) ?? new Set();

let dir: string;
let mnt: string;
let outDir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "input-host-paths-"));
  mnt = join(dir, "session", "mnt");
  outDir = join(dir, "run");
  mkdirSync(mnt, { recursive: true });
  mkdirSync(outDir, { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const mount = (mountPath: string, kind: Mount["kind"], mode: Mount["mode"] = "r"): Mount => ({
  hostPath: "/unused",
  mountPath,
  mode,
  kind,
});
const put = (rel: string, body: string | Buffer) => {
  const p = join(mnt, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, body);
};
const say = (text: string) => JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } });
const toolResult = (text: string) =>
  JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: text }] } });
const events = (...lines: string[]) => {
  const f = join(outDir, "events.jsonl");
  writeFileSync(f, lines.join("\n") + "\n");
  return f;
};
const corpusOf = (tokens: Iterable<string>, neverExemptRoots: string[] = [outDir]) => ({ tokens: new Set(tokens), neverExemptRoots });

// A realistic kept run dir's status/result JSON, connected as a folder: the paths a user would really feed in.
const KEPT_RESULT = JSON.stringify(
  {
    outDir: "/Users/alice/.cowork-harness/runs/local_abc123",
    workDir: "/Users/alice/.cowork-harness/runs/local_abc123/work/session",
    vmWork: "/Users/alice/.cowork-harness/vm-work/local_abc123/mnt/outputs/report.md",
    note: "see /Users/alice/proj/notes.md for context",
  },
  null,
  2,
);

describe("hostPathTokens — the full path token, sharing hostPathLeaked's roots and boundary", () => {
  it("extracts each whole path up to its delimiter", () => {
    expect(hostPathTokens('cat "/Users/alice/x/result.json" and /home/bob/y.txt, then `/private/tmp/z`')).toEqual([
      "/Users/alice/x/result.json",
      "/home/bob/y.txt",
      "/private/tmp/z",
    ]);
  });
  it("a backslash ends a token; the decoded form contributes its own tokens", () => {
    expect(hostPathTokens("a /Users/alice/x\\n/Users/bob/y")).toEqual(expect.arrayContaining(["/Users/alice/x"]));
    expect(hostPathTokens("open %2FUsers%2Falice%2Fx now")).toContain("/Users/alice/x");
  });
  it("is non-empty exactly when hostPathLeaked is true (behaviour-identical)", () => {
    for (const t of [
      "",
      "no paths here",
      "/sessions/abc/mnt/outputs/x",
      "/Users/alice",
      "path=/home/x",
      "computer:///Users/alice/f.md",
      "file://localhost/Users/alice/f",
      "whatever/home/x",
      "%2Fhome%2Fvictim",
      "build 100% done",
      "file:\\\\host\\Users\\alice",
      "(/opt/cowork/agent)",
      "x/Users/alice",
    ])
      expect({ t, tokens: hostPathTokens(t).length > 0 }).toEqual({ t, tokens: hostPathLeaked(t) });
  });
});

describe("captureInputHostPathCorpus — the pre-run corpus of host paths the user supplied", () => {
  it("collects tokens from staged uploads and connected folders, sorted, into a private sidecar", () => {
    put("uploads/result.json", KEPT_RESULT);
    put("proj/logs/run.log", "wrote /Users/alice/proj/out.txt\n");
    capture({ mounts: [mount("uploads/result.json", "upload"), mount("proj", "folder", "rw")], resume: false }, mnt, outDir);
    const tokens = [...readCorpus(outDir)];
    expect(tokens).toEqual(
      [
        "/Users/alice/.cowork-harness/runs/local_abc123",
        "/Users/alice/.cowork-harness/runs/local_abc123/work/session",
        "/Users/alice/.cowork-harness/vm-work/local_abc123/mnt/outputs/report.md",
        "/Users/alice/proj/notes.md",
        "/Users/alice/proj/out.txt",
      ].sort(),
    );
    expect(existsSync(join(outDir, "input-host-paths.json"))).toBe(true);
  });

  it("ignores plugin mounts, the managed config dir and outputs — they are not user input", () => {
    put("outputs/x.md", "/Users/alice/out/a");
    put(".claude/settings.json", '{"p":"/Users/alice/cfg"}');
    put(".local-plugins/p/SKILL.md", "/Users/alice/plugin/b");
    capture({ mounts: [mount(".local-plugins/p", "local-plugin")], resume: false }, mnt, outDir);
    expect(readCorpus(outDir).size).toBe(0);
  });

  it("does not tokenize oversize or binary files, nor .git/ or node_modules/", () => {
    put("proj/big.txt", "/Users/alice/big/x " + "a".repeat(2 * 1024 * 1024));
    put("proj/bin.dat", Buffer.concat([Buffer.from("/Users/alice/bin/x "), Buffer.from([0]), Buffer.from(" tail")]));
    put("proj/.git/config", "/Users/alice/git/x");
    put("proj/node_modules/m/index.js", "/Users/alice/nm/x");
    put("proj/ok.txt", "/Users/alice/ok/x");
    capture({ mounts: [mount("proj", "folder")], resume: false }, mnt, outDir);
    expect([...readCorpus(outDir)]).toEqual(["/Users/alice/ok/x"]);
  });

  it("is captured on a fresh stage only — a resumed turn never re-walks (the folder is writable)", () => {
    put("proj/a.txt", "/Users/alice/a");
    const plan = { mounts: [mount("proj", "folder", "rw")], resume: false };
    capture(plan, mnt, outDir);
    // Turn 1's agent writes a host path into the rw folder …
    put("proj/b.txt", "/Users/alice/written-by-agent");
    // … and turn 2 (resume) must not pick it up.
    capture({ ...plan, resume: true }, mnt, outDir);
    expect([...readCorpus(outDir)]).toEqual(["/Users/alice/a"]);
  });

  it("the sidecar is written above the staged tree, never inside it", () => {
    put("proj/a.txt", "/Users/alice/a");
    capture({ mounts: [mount("proj", "folder")], resume: false }, mnt, outDir);
    expect(existsSync(join(mnt, "input-host-paths.json"))).toBe(false);
    expect(JSON.parse(readFileSync(join(outDir, "input-host-paths.json"), "utf8")).tokens).toEqual(["/Users/alice/a"]);
  });
});

describe("scanEvents — a host path the user supplied is not a leak", () => {
  it("(a) the agent quoting a path from a connected kept result.json is exempt and counted", () => {
    put("prior/result.json", KEPT_RESULT);
    capture({ mounts: [mount("prior", "folder")], resume: false }, mnt, outDir);
    const f = events(toolResult(KEPT_RESULT), say("The prior run wrote /Users/alice/proj/notes.md earlier."));
    const scan = scanEvents(f, ["outputs"], corpusOf(readCorpus(outDir)) as any) as any;
    expect(scan.hostPathLeaked).toBe(false);
    expect(scan.hostPathsFromInputs).toBe(4);
  });

  it("(b) a host path NOT in the inputs still leaks, even beside an exempt one", () => {
    const f = events(say("see /Users/alice/proj/notes.md and /Users/bob/other"));
    const scan = scanEvents(f, ["outputs"], corpusOf(["/Users/alice/proj/notes.md"]) as any);
    expect(scan.hostPathLeaked).toBe(true);
  });

  it("(c) a path under a root the harness created for THIS run is never exempt, even if an input names it", () => {
    const own = join(outDir, "work", "session", "mnt", "outputs", "r.md");
    const f = events(say(`saved to ${own}`));
    const scan = scanEvents(f, ["outputs"], corpusOf([own], [outDir]) as any) as any;
    expect(scan.hostPathLeaked).toBe(true);
    expect(scan.hostPathsFromInputs ?? 0).toBe(0);
  });

  it("(d) a path that only appears in an oversize or binary input still leaks", () => {
    put("proj/big.txt", "/Users/alice/big/x " + "a".repeat(2 * 1024 * 1024));
    capture({ mounts: [mount("proj", "folder")], resume: false }, mnt, outDir);
    const f = events(say("found /Users/alice/big/x"));
    expect(scanEvents(f, ["outputs"], corpusOf(readCorpus(outDir)) as any).hostPathLeaked).toBe(true);
  });

  it("(e) a host path the agent wrote into a rw folder in turn 1 leaks when quoted in turn 2", () => {
    put("proj/a.txt", "/Users/alice/a");
    const plan = { mounts: [mount("proj", "folder", "rw")], resume: false };
    capture(plan, mnt, outDir);
    put("proj/b.txt", "/Users/alice/written-by-agent");
    capture({ ...plan, resume: true }, mnt, outDir);
    const f = events(toolResult("/Users/alice/written-by-agent"));
    expect(scanEvents(f, ["outputs"], corpusOf(readCorpus(outDir)) as any).hostPathLeaked).toBe(true);
  });

  it("(f) an encoded spelling whose decoded token came from an input is exempt", () => {
    const f = events(say("link: file:///x?p=%2FUsers%2Falice%2Fx"));
    const scan = scanEvents(f, ["outputs"], corpusOf(["/Users/alice/x"]) as any) as any;
    expect(scan.hostPathLeaked).toBe(false);
  });

  it("control: with no corpus, behaviour is unchanged", () => {
    const f = events(say("see /Users/alice/proj/notes.md"));
    expect(scanEvents(f).hostPathLeaked).toBe(true);
  });
});

describe("verdict — a pass that relied on the exemption says so", () => {
  const rr = (scan: RunResult["scan"]): RunResult => ({
    scenario: "t",
    fidelity: "container",
    effectiveFidelity: "container",
    baseline: "x",
    result: "success",
    decisions: [],
    egress: [],
    assertions: [],
    outDir: "/tmp/x",
    scan,
  });
  it("no host_path_leak signal, and a notice naming the count", () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((c: any) => {
      writes.push(String(c));
      return true;
    });
    try {
      const v = computeVerdict(
        rr({ outputsDeletes: [], hostPathLeaked: false, selfHealRan: false, inputHostPathTokens: 5, hostPathsFromInputs: 2 } as any),
        "live",
      );
      expect(v.signals.map((s) => s.code)).not.toContain("host_path_leak");
    } finally {
      spy.mockRestore();
    }
    expect(writes.join("")).toMatch(
      /::notice:: \[verdict\] 2 host path\(s\) in model-visible text came verbatim from the scenario's input files/,
    );
  });
});

// The pieces above are exercised directly; these pin that the runtime actually wires them together.
describe("wiring", () => {
  const src = (p: string) => readFileSync(join(import.meta.dirname, "..", "src", p), "utf8");
  for (const tier of ["runtime/container.ts", "runtime/microvm.ts"])
    it(`${tier} captures the corpus right after staging`, () => {
      const s = src(tier);
      const staged = s.indexOf("stageWorkspace(plan, mntHost)");
      const captured = s.indexOf("captureInputHostPathCorpus(plan, mntHost, outDir)");
      expect(staged).toBeGreaterThan(-1);
      expect(captured).toBeGreaterThan(staged);
    });
  it("execute.ts hands the persisted corpus to scanEvents", () => {
    expect(src("run/execute.ts")).toMatch(/scanEvents\(join\(outDir, "events\.jsonl"\), deleteDeniedRootsFromPlan\(plan\), inputCorpus\)/);
  });
});

describe("ownHostRoots — what the harness created for this run", () => {
  it("covers the run dir (raw and realpath), the microvm session dir and the staged agent dir", async () => {
    const { VM_WORK_HOST } = await import("../src/runtime/lima.js");
    const { realpathSync } = await import("node:fs");
    const roots = execute.ownHostRoots(outDir, "local_sid", { agentBinary: { stagedPath: "/x/claude-code-vm/2.1.0/claude" } } as any);
    expect(roots).toContain(outDir);
    expect(roots).toContain(realpathSync(outDir)); // /var/folders vs /private/var/folders on macOS
    expect(roots).toContain(join(VM_WORK_HOST, "local_sid"));
    expect(roots).toContain("/x/claude-code-vm/2.1.0");
  });
});
