import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";
import { PY_SCAFFOLD_FLAGS, resolveScenarioScript } from "../src/run/scenario-tool.js";

// There is ONE `scaffold` command. With a <run-id | run-dir> it turns a kept run into a scenario (native);
// given the bundled script's flags (`--name`, `--skill`, `--prompt`, …) it builds one from flags alone by
// delegating to `scenario.py scaffold`, the way `lint` delegates. Before, that flag set failed on the native
// command with `unknown flag: --name`, and the docs carried a "two different scaffold tools" warning.
// Token-free: nothing here spawns an agent.
const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);
const py = process.env.PYTHON ?? "python3";
const havePython = spawnSync(py, ["--version"], { stdio: "ignore" }).status === 0;

function cli(args: string[], cwd: string) {
  const r = spawnSync("node", [CLI, ...args], { encoding: "utf8", cwd });
  return { code: r.status, stdout: r.stdout || "", stderr: r.stderr || "", out: (r.stdout || "") + (r.stderr || "") };
}

describe.skipIf(!can || !havePython)("scaffold delegates the flag-built form to the bundled scenario.py", () => {
  it("--name/--skill/--prompt/--out writes a scenario that the harness's own lint loads (exit 0)", () => {
    const d = mkdtempSync(join(tmpdir(), "scaffold-deleg-"));
    const r = cli(["scaffold", "--name", "x", "--skill", "./skills/y", "--prompt", "do p", "--out", "s.yaml"], d);
    expect(r.code, r.out).toBe(0);
    const f = join(d, "s.yaml");
    expect(existsSync(f)).toBe(true);
    const doc = parseYaml(readFileSync(f, "utf8"));
    expect(doc.name).toBe("x");
    expect(doc.prompt).toContain("do p");
    const lint = cli(["lint", "s.yaml"], d);
    expect(lint.code, lint.out).toBe(0);
  });

  it("without --out the YAML goes to stdout", () => {
    const d = mkdtempSync(join(tmpdir(), "scaffold-deleg-"));
    const r = cli(["scaffold", "--name", "x", "--prompt", "p"], d);
    expect(r.code, r.out).toBe(0);
    expect(parseYaml(r.stdout).name).toBe("x");
  });

  it("the equals form triggers delegation too", () => {
    const d = mkdtempSync(join(tmpdir(), "scaffold-deleg-"));
    const r = cli(["scaffold", "--name=x", "--prompt=p"], d);
    expect(r.code, r.out).toBe(0);
    expect(parseYaml(r.stdout).name).toBe("x");
  });

  it("the script's own usage errors name `cowork-harness scaffold`, not scenario.py", () => {
    const d = mkdtempSync(join(tmpdir(), "scaffold-deleg-"));
    const r = cli(["scaffold", "--name", "x", "--tier", "bogus"], d);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("cowork-harness scaffold");
    expect(r.stderr).not.toContain("scenario.py");
  });

  it("--output-format json on the flag-built form is a usage error that says why (the script emits YAML only)", () => {
    const d = mkdtempSync(join(tmpdir(), "scaffold-deleg-"));
    const r = cli(["scaffold", "--name", "x", "--output-format", "json"], d);
    expect(r.code).toBe(2);
    const env = JSON.parse(r.stdout.trim());
    expect(env.error.category).toBe("usage");
    expect(env.error.message).toMatch(/YAML/);
  });

  it("mixing a <run-id> with the flag-built form is a usage error, not a silent pick of one", () => {
    const d = mkdtempSync(join(tmpdir(), "scaffold-deleg-"));
    const r = cli(["scaffold", "some-run-id", "--name", "x"], d);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/some-run-id/);
  });
});

describe.skipIf(!can)("the native run-id form is unchanged", () => {
  it("bare `scaffold` is still a usage error naming both forms", () => {
    const d = mkdtempSync(join(tmpdir(), "scaffold-deleg-"));
    const r = cli(["scaffold"], d);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/<run-id \| run-dir>/);
    expect(r.out).toMatch(/--name/);
  });

  it("an unresolvable run id is still exit 2 from the native path", () => {
    const d = mkdtempSync(join(tmpdir(), "scaffold-deleg-"));
    const r = cli(["scaffold", "no-such-run-xyz", "--out", "s.yaml"], d);
    expect(r.code).toBe(2);
    expect(existsSync(join(d, "s.yaml"))).toBe(false);
  });

  it("an unknown flag that is not the script's is still an unknown-flag error", () => {
    const d = mkdtempSync(join(tmpdir(), "scaffold-deleg-"));
    const r = cli(["scaffold", "run-x", "--nmae", "x"], d);
    expect(r.code).toBe(2);
    expect(r.out).toContain("unknown flag: --nmae");
  });
});

describe("PY_SCAFFOLD_FLAGS mirrors scenario.py's scaffold parser (the delegation trigger cannot drift)", () => {
  it("every `sp.add_argument` flag except the shared --out is listed, and nothing else", () => {
    const src = readFileSync(resolveScenarioScript(), "utf8");
    const declared = [...src.matchAll(/^\s*sp\.add_argument\(\s*"(--[a-z-]+)"/gm)].map((m) => m[1]);
    expect(declared.length).toBeGreaterThan(10);
    expect([...PY_SCAFFOLD_FLAGS].sort()).toEqual(declared.filter((f) => f !== "--out").sort());
  });
});

describe.skipIf(!can || !havePython)("the flag-built scaffold treats the env json default like the flag", () => {
  it("COWORK_HARNESS_OUTPUT_FORMAT=json is refused the same way --output-format json is (never silently ignored)", () => {
    const d = mkdtempSync(join(tmpdir(), "scaffold-deleg-"));
    const r = spawnSync("node", [CLI, "scaffold", "--name", "x", "--prompt", "p"], {
      encoding: "utf8",
      cwd: d,
      env: { ...process.env, COWORK_HARNESS_OUTPUT_FORMAT: "json" },
    });
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stdout.trim()).error.message).toMatch(/YAML/);
  });

  it("an explicit --output-format text overrides the env json and runs", () => {
    const d = mkdtempSync(join(tmpdir(), "scaffold-deleg-"));
    const r = spawnSync("node", [CLI, "scaffold", "--name", "x", "--prompt", "p", "--output-format", "text"], {
      encoding: "utf8",
      cwd: d,
      env: { ...process.env, COWORK_HARNESS_OUTPUT_FORMAT: "json" },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(parseYaml(r.stdout).name).toBe("x");
  });
});
