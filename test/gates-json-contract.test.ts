import { describe, it, expect } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// `gates <dir>` — the error paths a driving agent can hit, and what each one owes a JSON consumer.
// - a directory that does not exist (one pass): a usage error, not a silent exit 0 that reads as "no gates";
// - a path that is not a directory: a usage error in both modes;
// - a malformed gate request: a `runtime` error (the channel failed), not `internal` (a harness bug) —
//   under --follow after bounded retries, and in one pass on the first read (one pass has no retry);
// - `--follow` on a directory that does not exist yet stays tolerant (the run creates it), and says so once.
const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);
// The var is REMOVED, not blanked: an empty value is itself refused as an invalid format.
const { COWORK_HARNESS_OUTPUT_FORMAT: _inherited, ...inheritedEnv } = process.env;

function gates(args: string[], env: NodeJS.ProcessEnv = {}) {
  const r = spawnSync("node", [CLI, "gates", ...args], {
    encoding: "utf8",
    env: { ...inheritedEnv, ...env },
    timeout: 20_000,
  });
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function lastDoc(stdout: string): { ok?: boolean; error?: { category?: string; message?: string }; done?: boolean } {
  const lines = stdout.split("\n").filter((l) => l.trim());
  return JSON.parse(lines[lines.length - 1]);
}

describe.skipIf(!can)("gates <dir> — error paths", () => {
  it("a missing directory (one pass) is a usage error, exit 2", () => {
    const missing = join(mkdtempSync(join(tmpdir(), "gates-")), "nope");
    const r = gates([missing, "--output-format", "json"]);
    expect(r.code, r.stderr).toBe(2);
    const doc = JSON.parse(r.stdout);
    expect(doc.ok).toBe(false);
    expect(doc.error.category).toBe("usage");
  });

  it("a missing directory (one pass) is a usage error in text mode too", () => {
    const missing = join(mkdtempSync(join(tmpdir(), "gates-")), "nope");
    const r = gates([missing]);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/nope/);
  });

  it("a path that is a regular file is a usage error, with or without --follow", () => {
    const f = join(mkdtempSync(join(tmpdir(), "gates-")), "file");
    writeFileSync(f, "x");
    for (const extra of [[], ["--follow"]]) {
      const r = gates([f, ...extra, "--output-format", "json"]);
      expect(r.code, r.stderr).toBe(2);
      expect(JSON.parse(r.stdout).error.category).toBe("usage");
    }
  });

  it("one pass: a malformed gate request is a runtime error on the first read", () => {
    const d = mkdtempSync(join(tmpdir(), "gates-"));
    writeFileSync(join(d, "req-1.json"), "{not json");
    const r = gates([d, "--output-format", "json"]);
    expect(r.code, r.stderr).toBe(2);
    const doc = JSON.parse(r.stdout);
    expect(doc.ok).toBe(false);
    expect(doc.error.category).toBe("runtime");
    expect(doc.error.message).toMatch(/req-1\.json/);
  });

  it("--follow: a persistently malformed gate request ends the stream with a runtime error envelope", () => {
    const d = mkdtempSync(join(tmpdir(), "gates-"));
    writeFileSync(join(d, "req-1.json"), "{not json");
    const r = gates([d, "--follow", "--output-format", "json"], { COWORK_HARNESS_DECIDER_DIR_POLL_MS: "10" });
    expect(r.code, r.stderr).toBe(2);
    const doc = lastDoc(r.stdout);
    expect(doc.ok).toBe(false);
    expect(doc.error?.category).toBe("runtime");
  });

  it("--follow on a directory that does not exist yet waits for it, says so once, then streams", async () => {
    const d = join(mkdtempSync(join(tmpdir(), "gates-")), "later");
    const child = spawn("node", [CLI, "gates", d, "--follow"], {
      env: { ...inheritedEnv, COWORK_HARNESS_DECIDER_DIR_POLL_MS: "20" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => (stdout += String(b)));
    child.stderr.on("data", (b) => (stderr += String(b)));
    const exited = new Promise<number | null>((res) => child.on("exit", (c) => res(c)));
    // Wait for the notice, then create the directory and finish the run.
    const deadline = Date.now() + 10_000;
    while (!/waiting for/.test(stderr) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    expect(stderr).toMatch(/waiting for .*later/);
    mkdirSync(d);
    writeFileSync(join(d, "done.json"), JSON.stringify({ done: true }));
    const code = await Promise.race([exited, new Promise<null>((r) => setTimeout(() => (child.kill(), r(null)), 10_000))]);
    expect(code, stderr).toBe(0);
    expect(stdout.trim()).toBe(JSON.stringify({ done: true }));
    expect(stderr.match(/waiting for/g)?.length).toBe(1);
  });
});
