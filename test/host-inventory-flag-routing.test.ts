import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Three host-inventory flags live on two commands: `record --allow-host-inventory-fixture` (past the
// pre-flight refusal), `record --allow-host-inventory-findings` (write a recording the scan flagged) and
// `verify-cassettes --allow-host-inventory <regex>` (suppress one finding on a committed cassette). Passing
// one to the other command used to answer a bare `unknown flag`, leaving the user to find the sibling. The
// error now names the command that owns the flag. Token-free: every case is a parse-time usage error.
const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);

function cli(args: string[]) {
  const r = spawnSync("node", [CLI, ...args], { encoding: "utf8" });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || ""), stdout: r.stdout || "" };
}

describe.skipIf(!can)("a host-inventory flag on the wrong command names the command that owns it", () => {
  for (const flag of ["--allow-host-inventory-fixture", "--allow-host-inventory-findings"]) {
    for (const cmd of ["verify-cassettes", "replay"]) {
      it(`${cmd} ${flag} → usage error naming \`record ${flag}\``, () => {
        const r = cli([cmd, "x.cassette.json", flag]);
        expect(r.code).toBe(2);
        expect(r.out).toContain(`unknown flag: ${flag}`);
        expect(r.out).toContain(`record`);
        expect(r.out).toMatch(new RegExp(`record [^\\n]*${flag}`));
      });
    }
  }

  for (const form of [["--allow-host-inventory", "acme"], ["--allow-host-inventory=acme"]]) {
    it(`record ${form.join(" ")} → usage error naming \`verify-cassettes --allow-host-inventory\``, () => {
      const r = cli(["record", "x.yaml", ...form]);
      expect(r.code).toBe(2);
      expect(r.out).toContain("unknown flag: --allow-host-inventory");
      expect(r.out).toMatch(/verify-cassettes --allow-host-inventory <regex>/);
      // …and it points at record's own pair, so a user who meant the record-time consent finds it.
      expect(r.out).toContain("--allow-host-inventory-fixture");
    });
  }

  it("json mode carries the routing in the envelope's hint", () => {
    const r = cli(["verify-cassettes", "x.cassette.json", "--allow-host-inventory-fixture", "--output-format", "json"]);
    expect(r.code).toBe(2);
    const env = JSON.parse(r.stdout.trim());
    expect(env.error.category).toBe("usage");
    expect(env.error.hint).toMatch(/record [^\n]*--allow-host-inventory-fixture/);
  });

  it("an unrelated unknown flag keeps the plain message (no hint invented)", () => {
    const r = cli(["verify-cassettes", "x.cassette.json", "--allow-host-inventoryy", "--output-format", "json"]);
    expect(r.code).toBe(2);
    const env = JSON.parse(r.stdout.trim());
    expect(env.error.hint).toBeUndefined();
  });
});
