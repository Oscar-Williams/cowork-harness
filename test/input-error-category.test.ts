import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// A path the user named that does not exist is a USAGE error (category `usage`, exit 2) — not `internal`,
// which tells the reader the harness itself is broken. And a run refused for it leaves NO run directory
// behind: the mount sources are checked before the run dir is created, so `status`/`list` never show a
// run that never started.
const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);
const { COWORK_HARNESS_OUTPUT_FORMAT: _inherited, ...inheritedEnv } = process.env;

function cli(args: string[], runs: string, cwd?: string) {
  const r = spawnSync("node", [CLI, ...args, "--output-format", "json"], {
    encoding: "utf8",
    cwd,
    env: {
      ...inheritedEnv,
      COWORK_HARNESS_RUNS_DIR: runs,
      COWORK_HARNESS_FORBID_SPAWN: "1",
      COWORK_HARNESS_SOFT_MISSING: "",
      COWORK_HARNESS_MODEL: "",
    },
  });
  let doc: any;
  try {
    doc = JSON.parse(r.stdout ?? "");
  } catch (e) {
    throw new Error(`stdout is not exactly one JSON document (${(e as Error).message}):\n${r.stdout}\nstderr:\n${r.stderr}`);
  }
  return { code: r.status, doc, stderr: r.stderr ?? "" };
}

/** Every file or directory under the runs root (the refused run must add none). */
function runsContent(runs: string): string[] {
  return readdirSync(runs, { recursive: true }).map(String);
}

describe.skipIf(!can)("a missing input path is a usage error and leaves no run dir", () => {
  it("answer <missing dir> --gate 1 --answer q=a → usage", () => {
    const runs = mkdtempSync(join(tmpdir(), "iec-runs-"));
    const missing = join(mkdtempSync(join(tmpdir(), "iec-")), "nope");
    const r = cli(["answer", missing, "--gate", "1", "--answer", "q=a"], runs);
    expect(r.code, r.stderr).toBe(2);
    expect(r.doc.ok).toBe(false);
    expect(r.doc.error.category).toBe("usage");
  });

  it("skill <missing plugin> hi --model x → usage, no run dir", () => {
    const runs = mkdtempSync(join(tmpdir(), "iec-runs-"));
    const missing = join(mkdtempSync(join(tmpdir(), "iec-")), "nope");
    const r = cli(["skill", missing, "hi", "--model", "claude-test-model"], runs);
    expect(r.code, r.stderr).toBe(2);
    expect(r.doc.error.category).toBe("usage");
    expect(r.doc.error.message).toMatch(/not found/);
    expect(runsContent(runs), "a refused run left a run dir behind").toEqual([]);
  });

  it("skill <missing plugin> hi --dry-run → usage (a preview must surface a path that does not exist)", () => {
    const runs = mkdtempSync(join(tmpdir(), "iec-runs-"));
    const missing = join(mkdtempSync(join(tmpdir(), "iec-")), "nope");
    const r = cli(["skill", missing, "hi", "--dry-run"], runs);
    expect(r.code, r.stderr).toBe(2);
    expect(r.doc.error.category).toBe("usage");
  });

  it("skill <plugin> hi --upload <missing file> --model x → usage, no run dir", () => {
    const runs = mkdtempSync(join(tmpdir(), "iec-runs-"));
    const plugin = mkdtempSync(join(tmpdir(), "iec-plugin-"));
    writeFileSync(join(plugin, "SKILL.md"), "---\nname: p\ndescription: d\n---\nbody\n");
    const r = cli(["skill", plugin, "hi", "--upload", join(plugin, "nope.pdf"), "--model", "claude-test-model"], runs);
    expect(r.code, r.stderr).toBe(2);
    expect(r.doc.error.category).toBe("usage");
    expect(runsContent(runs)).toEqual([]);
  });

  // The WRONG KIND of path is the same class of input error as a missing one.
  it("skill <a file, not a folder> hi --dry-run → usage", () => {
    const runs = mkdtempSync(join(tmpdir(), "iec-runs-"));
    const f = join(mkdtempSync(join(tmpdir(), "iec-")), "plugin.txt");
    writeFileSync(f, "x");
    const r = cli(["skill", f, "hi", "--dry-run"], runs);
    expect(r.code, r.stderr).toBe(2);
    expect(r.doc.error.category).toBe("usage");
  });

  it("skill <plugin> hi --upload <a directory> --dry-run → usage", () => {
    const runs = mkdtempSync(join(tmpdir(), "iec-runs-"));
    const plugin = mkdtempSync(join(tmpdir(), "iec-plugin-"));
    writeFileSync(join(plugin, "SKILL.md"), "---\nname: p\ndescription: d\n---\nbody\n");
    const r = cli(["skill", plugin, "hi", "--upload", mkdtempSync(join(tmpdir(), "iec-dir-")), "--dry-run"], runs);
    expect(r.code, r.stderr).toBe(2);
    expect(r.doc.error.category).toBe("usage");
  });

  it("skill <plugin> hi --folder <a file> --model x → usage, no run dir", () => {
    const runs = mkdtempSync(join(tmpdir(), "iec-runs-"));
    const plugin = mkdtempSync(join(tmpdir(), "iec-plugin-"));
    writeFileSync(join(plugin, "SKILL.md"), "---\nname: p\ndescription: d\n---\nbody\n");
    const r = cli(["skill", plugin, "hi", "--folder", join(plugin, "SKILL.md"), "--model", "claude-test-model"], runs);
    expect(r.code, r.stderr).toBe(2);
    expect(r.doc.error.category).toBe("usage");
    expect(runsContent(runs)).toEqual([]);
  });

  it("skill <plugin> hi --upload a/x.pdf --upload b/x.pdf (one destination) --dry-run → usage", () => {
    const runs = mkdtempSync(join(tmpdir(), "iec-runs-"));
    const plugin = mkdtempSync(join(tmpdir(), "iec-plugin-"));
    writeFileSync(join(plugin, "SKILL.md"), "---\nname: p\ndescription: d\n---\nbody\n");
    const a = mkdtempSync(join(tmpdir(), "iec-a-"));
    const b = mkdtempSync(join(tmpdir(), "iec-b-"));
    writeFileSync(join(a, "x.pdf"), "a");
    writeFileSync(join(b, "x.pdf"), "b");
    const r = cli(["skill", plugin, "hi", "--upload", join(a, "x.pdf"), "--upload", join(b, "x.pdf"), "--dry-run"], runs);
    expect(r.code, r.stderr).toBe(2);
    expect(r.doc.error.category).toBe("usage");
  });

  it('skill <plugin> hi --session-id "a/b" --model x → usage, no run dir', () => {
    const runs = mkdtempSync(join(tmpdir(), "iec-runs-"));
    const plugin = mkdtempSync(join(tmpdir(), "iec-plugin-"));
    writeFileSync(join(plugin, "SKILL.md"), "---\nname: p\ndescription: d\n---\nbody\n");
    const r = cli(["skill", plugin, "hi", "--session-id", "a/b", "--model", "claude-test-model"], runs);
    expect(r.code, r.stderr).toBe(2);
    expect(r.doc.error.category).toBe("usage");
    expect(runsContent(runs)).toEqual([]);
  });

  it("skill <missing plugin> hi --ablate-skill --dry-run → usage (ablation does not skip the input check)", () => {
    const runs = mkdtempSync(join(tmpdir(), "iec-runs-"));
    const missing = join(mkdtempSync(join(tmpdir(), "iec-")), "nope");
    const r = cli(["skill", missing, "hi", "--ablate-skill", "--dry-run"], runs);
    expect(r.code, r.stderr).toBe(2);
    expect(r.doc.error.category).toBe("usage");
  });

  it("run <scenario whose session declares a skill that does not exist> --model x → usage, no run dir", () => {
    const runs = mkdtempSync(join(tmpdir(), "iec-runs-"));
    const work = mkdtempSync(join(tmpdir(), "iec-run-"));
    writeFileSync(join(work, "session.yaml"), `skills:\n  local:\n    - ./nope\n`);
    writeFileSync(
      join(work, "s.yaml"),
      `name: missing-skill\nprompt: "x"\nfidelity: protocol\nsession: ./session.yaml\nassert:\n  - result: success\n`,
    );
    const r = cli(["run", join(work, "s.yaml"), "--model", "claude-test-model"], runs, work);
    expect(r.code, r.stderr).toBe(2);
    expect(r.doc.error.category).toBe("usage");
    expect(r.doc.error.message).toMatch(/not found/);
    expect(runsContent(runs), "a refused run left a run dir behind").toEqual([]);
  });

  it("run <scenario whose session uploads a missing file> --model x → usage, no run dir", () => {
    const runs = mkdtempSync(join(tmpdir(), "iec-runs-"));
    const work = mkdtempSync(join(tmpdir(), "iec-run-"));
    writeFileSync(join(work, "session.yaml"), `uploads:\n  - ./nope.pdf\n`);
    writeFileSync(
      join(work, "s.yaml"),
      `name: missing-upload\nprompt: "x"\nfidelity: protocol\nsession: ./session.yaml\nassert:\n  - result: success\n`,
    );
    const r = cli(["run", join(work, "s.yaml"), "--model", "claude-test-model"], runs, work);
    expect(r.code, r.stderr).toBe(2);
    expect(r.doc.error.category).toBe("usage");
    expect(r.doc.error.message).toMatch(/not found/);
    expect(runsContent(runs), "a refused run left a run dir behind").toEqual([]);
  });

  // verify-run: a run dir or scenario file the caller named that is not there is their input. (A run dir that
  // exists but holds no completed run stays `runtime`: that is the prior run's state, not a typo.)
  function keptRun(): string {
    const root = mkdtempSync(join(tmpdir(), "iec-kept-"));
    const workDir = join(root, "work", "session", "mnt");
    mkdirSync(join(workDir, "outputs"), { recursive: true });
    const t1 = join(root, "turns", "1");
    mkdirSync(t1, { recursive: true });
    writeFileSync(
      join(t1, "result.json"),
      JSON.stringify({
        scenario: "smoke",
        fidelity: "container",
        baseline: "desktop-1.14271.0",
        result: "success",
        decisions: [],
        toolCounts: { Read: 1 },
        gateDeliveries: [],
        egress: [],
        assertions: [],
        subagents: [],
        outDir: root,
        workDir,
        durationMs: 1,
        scan: { outputsDeletes: [], hostPathLeaked: false, selfHealRan: false },
      }),
    );
    writeFileSync(join(t1, "run.jsonl"), JSON.stringify({ t: "run", scenario: "smoke" }) + "\n");
    writeFileSync(join(t1, "trace.json"), JSON.stringify({ questions: [], steps: [] }));
    return root;
  }

  it("verify-run <missing run dir> <scenario> → usage", () => {
    const runs = mkdtempSync(join(tmpdir(), "iec-runs-"));
    const d = mkdtempSync(join(tmpdir(), "iec-vr-"));
    writeFileSync(join(d, "s.yaml"), "name: smoke\nprompt: x\nfidelity: container\nassert:\n  - result: success\n");
    const r = cli(["verify-run", join(d, "nope"), join(d, "s.yaml")], runs);
    expect(r.code, r.stderr).toBe(2);
    expect(r.doc.error.category).toBe("usage");
  });

  it("verify-run <run dir> <missing scenario> → usage", () => {
    const runs = mkdtempSync(join(tmpdir(), "iec-runs-"));
    const r = cli(["verify-run", keptRun(), join(mkdtempSync(join(tmpdir(), "iec-vr-")), "nope.yaml")], runs);
    expect(r.code, r.stderr).toBe(2);
    expect(r.doc.error.category).toBe("usage");
  });

  it("verify-run <an empty dir> <scenario> stays runtime (not a completed run)", () => {
    const runs = mkdtempSync(join(tmpdir(), "iec-runs-"));
    const d = mkdtempSync(join(tmpdir(), "iec-vr-"));
    writeFileSync(join(d, "s.yaml"), "name: smoke\nprompt: x\nfidelity: container\nassert:\n  - result: success\n");
    const r = cli(["verify-run", mkdtempSync(join(tmpdir(), "iec-empty-")), join(d, "s.yaml")], runs);
    expect(r.code, r.stderr).toBe(2);
    expect(r.doc.error.category).toBe("runtime");
  });

  // Under COWORK_HARNESS_SOFT_MISSING a missing source is dropped, not refused. The preview must not show it
  // as though it will load: the dry run prints the same one exclusion warning the real run prints.
  it("SOFT_MISSING: skill <missing plugin> hi --dry-run says the plugin is excluded, once", () => {
    const missing = join(mkdtempSync(join(tmpdir(), "iec-")), "nope");
    const r = spawnSync("node", [CLI, "skill", missing, "hi", "--dry-run"], {
      encoding: "utf8",
      env: { ...inheritedEnv, COWORK_HARNESS_SOFT_MISSING: "1", COWORK_HARNESS_MODEL: "" },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr.match(/excluded \(COWORK_HARNESS_SOFT_MISSING\)/g)?.length, r.stderr).toBe(1);
    expect(r.stderr).toContain(missing);
  });

  // `answer` maps only the caller's input to usage. A gate it found but could not write the answer for (an
  // unwritable directory) is the environment failing — runtime.
  it.skipIf(process.getuid?.() === 0)("answer: an unwritable decider dir is a runtime error, not usage", () => {
    const runs = mkdtempSync(join(tmpdir(), "iec-runs-"));
    const d = mkdtempSync(join(tmpdir(), "iec-answer-"));
    writeFileSync(join(d, "req-1.json"), JSON.stringify({ id: "g1", questions: [{ question: "q" }] }));
    chmodSync(d, 0o500);
    try {
      const r = cli(["answer", d, "--gate", "1", "--answer", "q=a"], runs);
      expect(r.code, r.stderr).toBe(2);
      expect(r.doc.error.category).toBe("runtime");
    } finally {
      chmodSync(d, 0o700);
    }
  });

  // answer: the caller's input is "which dir, which gate". A gate request that exists but cannot be read or
  // parsed is the channel failing — runtime, as `gates` reports it.
  for (const form of [
    ["--answer", "q=a"],
    ["--choose", "A"],
  ]) {
    it(`answer ${form[0]}: a malformed gate request is runtime`, () => {
      const runs = mkdtempSync(join(tmpdir(), "iec-runs-"));
      const d = mkdtempSync(join(tmpdir(), "iec-answer-"));
      writeFileSync(join(d, "req-1.json"), "{not json");
      const r = cli(["answer", d, "--gate", "1", ...form], runs);
      expect(r.code, r.stderr).toBe(2);
      expect(r.doc.error.category).toBe("runtime");
      expect(r.doc.error.message).toMatch(/req-1\.json|JSON/);
    });

    it(`answer ${form[0]}: an existing dir with no such gate is usage`, () => {
      const runs = mkdtempSync(join(tmpdir(), "iec-runs-"));
      const r = cli(["answer", mkdtempSync(join(tmpdir(), "iec-answer-")), "--gate", "1", ...form], runs);
      expect(r.code, r.stderr).toBe(2);
      expect(r.doc.error.category).toBe("usage");
    });

    it.skipIf(process.getuid?.() === 0)(`answer ${form[0]}: an unreadable gate request is runtime, and says why`, () => {
      const runs = mkdtempSync(join(tmpdir(), "iec-runs-"));
      const d = mkdtempSync(join(tmpdir(), "iec-answer-"));
      writeFileSync(join(d, "req-1.json"), JSON.stringify({ id: "g1", questions: [{ question: "q", options: [{ label: "A" }] }] }));
      chmodSync(join(d, "req-1.json"), 0o000);
      try {
        const r = cli(["answer", d, "--gate", "1", ...form], runs);
        expect(r.code, r.stderr).toBe(2);
        expect(r.doc.error.category).toBe("runtime");
        // The FIRST read's error (the live request), not the `.done` fallback's ENOENT.
        expect(r.doc.error.message).toMatch(/EACCES/);
      } finally {
        chmodSync(join(d, "req-1.json"), 0o600);
      }
    });
  }

  it("verify-run <a regular file> <scenario> → usage", () => {
    const runs = mkdtempSync(join(tmpdir(), "iec-runs-"));
    const d = mkdtempSync(join(tmpdir(), "iec-vr-"));
    writeFileSync(join(d, "s.yaml"), "name: smoke\nprompt: x\nfidelity: container\nassert:\n  - result: success\n");
    const r = cli(["verify-run", join(d, "s.yaml"), join(d, "s.yaml")], runs);
    expect(r.code, r.stderr).toBe(2);
    expect(r.doc.error.category).toBe("usage");
  });

  // record --dry-run previews the same input paths skill --dry-run does; a scenario that loaded but names a
  // path that is not there is a refused recording (record's exit 1).
  it("record <scenario whose session uploads a missing file> --dry-run → usage, exit 1", () => {
    const runs = mkdtempSync(join(tmpdir(), "iec-runs-"));
    const work = mkdtempSync(join(tmpdir(), "iec-rec-"));
    writeFileSync(join(work, "session.yaml"), `uploads:\n  - ./nope.pdf\n`);
    writeFileSync(
      join(work, "s.yaml"),
      `name: rec-missing-upload\nprompt: "x"\nfidelity: protocol\nsession: ./session.yaml\nassert:\n  - result: success\n`,
    );
    const r = cli(["record", join(work, "s.yaml"), "--model", "claude-test-model", "--dry-run"], runs, work);
    expect(r.code, r.stderr).toBe(1);
    expect(r.doc.ok).toBe(false);
    expect(r.doc.error.category).toBe("usage");
    expect(r.doc.error.message).toMatch(/not found/);
  });

  it('skill <plugin> hi --upload "a:b.pdf" --dry-run → usage (an unsafe mount name)', () => {
    const runs = mkdtempSync(join(tmpdir(), "iec-runs-"));
    const plugin = mkdtempSync(join(tmpdir(), "iec-plugin-"));
    writeFileSync(join(plugin, "SKILL.md"), "---\nname: p\ndescription: d\n---\nbody\n");
    writeFileSync(join(plugin, "a:b.pdf"), "x");
    const r = cli(["skill", plugin, "hi", "--upload", join(plugin, "a:b.pdf"), "--dry-run"], runs);
    expect(r.code, r.stderr).toBe(2);
    expect(r.doc.error.category).toBe("usage");
  });

  for (const [label, session, expectMsg] of [
    ["an effort the model does not offer", "effort: max\nmodel: claude-haiku-4-5\n", /effort/],
    ["an effort value the schema rejects", "effort: bogus\n", /effort/],
  ] as const) {
    it(`run <scenario whose session has ${label}> → usage, readable, no run dir`, () => {
      const runs = mkdtempSync(join(tmpdir(), "iec-runs-"));
      const work = mkdtempSync(join(tmpdir(), "iec-eff-"));
      writeFileSync(join(work, "session.yaml"), session);
      writeFileSync(
        join(work, "s.yaml"),
        `name: bad-effort\nprompt: "x"\nfidelity: protocol\nsession: ./session.yaml\nassert:\n  - result: success\n`,
      );
      const r = cli(["run", join(work, "s.yaml"), "--model", "claude-haiku-4-5"], runs, work);
      expect(r.code, r.stderr).toBe(2);
      expect(r.doc.error.category).toBe("usage");
      expect(r.doc.error.message).toMatch(expectMsg);
      expect(r.doc.error.message.startsWith("["), "a raw schema issue array").toBe(false);
      expect(runsContent(runs)).toEqual([]);
    });
  }
});
