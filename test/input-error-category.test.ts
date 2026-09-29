import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
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
});
