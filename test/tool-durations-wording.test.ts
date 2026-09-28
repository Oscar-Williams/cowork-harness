import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Wording pins for toolDurations: what "unpaired" can observe, when the basis is present, what an id-less
// tool_use is, and the SPEC §12 additive-key sentence. Matched on whitespace-normalised text.
const read = (p: string) => readFileSync(resolve(p), "utf8").replace(/\s+/g, " ");
const schema = JSON.parse(readFileSync(resolve("schema/run-result.json"), "utf8")).properties;
const unreleased = (() => {
  const c = read("CHANGELOG.md");
  return c.slice(c.indexOf("## [Unreleased]"), c.indexOf("## [3.10.0]"));
})();

describe("toolDurations wording", () => {
  it("schema: unpaired is relative to what the harness observed, and microvm sub-agent delivery is unobserved", () => {
    expect(schema.toolDurations.description).toMatch(/never paired with a tool_result the harness observed/);
    expect(schema.toolDurations.description).toMatch(/microvm/);
    expect(schema.toolDurations.description).toMatch(/where observed/);
  });

  it("schema: the basis is present exactly when toolDurations is only for files written by this version or later", () => {
    expect(schema.toolDurationsBasis.description).toMatch(/\(result files written by this version or later\)/);
  });

  it("an id-less tool_use is described as an MCP round-trip/handshake echo, not the echo of an id-carrying call", () => {
    const sources = {
      // Only foldToolDurations's own doc comment (the foldSkillActivity comment below it is older text), with
      // the ` * ` comment leaders removed so a wrapped phrase still matches.
      fold: (() => {
        const src = readFileSync(resolve("src/run/timeline-fold.ts"), "utf8");
        const doc = src.slice(src.indexOf("/**\n * Pairs each `tool_use`"), src.indexOf("export function foldToolDurations"));
        return doc.replace(/\n\s*\*\s?/g, " ").replace(/\s+/g, " ");
      })(),
      unpaired: schema.toolDurations.additionalProperties.properties.unpaired.description as string,
      changelog: unreleased,
    };
    expect(sources.fold.length).toBeGreaterThan(500); // the doc-comment slice was found
    for (const [name, text] of Object.entries(sources)) {
      expect(text, name).not.toMatch(/already arrived with an id/);
      expect(text, name).toMatch(/MCP round-trip\/handshake echoes, which carry no id/);
    }
  });

  it("the docs qualify 'main-agent and sub-agent calls alike' with 'where observed'", () => {
    for (const p of [
      "docs/cli.md",
      ".claude/skills/cowork-harness/references/measurement.md",
      ".claude/skills/cowork-harness/references/debugging.md",
    ]) {
      const t = read(p);
      expect(t, p).not.toMatch(/sub-agent calls alike(?!,? where observed)/);
      expect(t, p).toMatch(/main-agent and sub-agent calls( alike)?, where observed/);
    }
  });

  it("the CHANGELOG upgrade note says an average needs a calls > 0 guard", () => {
    expect(unreleased).toMatch(/`totalMs \/ calls` needs a `calls > 0` guard/);
  });
});

describe("SPEC §12 RunResult additive-key sentence", () => {
  const spec = read("SPEC.md");
  const bullet = spec.slice(spec.indexOf("- **RunResult envelope**"), spec.indexOf("- **`verify-cassettes` envelope**"));
  it("does not claim the other envelope bullets say the same (they cover rename/remove only)", () => {
    expect(bullet).not.toMatch(/as for the envelopes below/);
  });
  it("says toolDurations' entry set is not its meaning, scoped to that key rather than every map", () => {
    expect(bullet).toMatch(/For `toolDurations`[^.]*the set of entries is not the key's meaning/);
    expect(bullet).toMatch(/calls: 0/);
    // toolCounts' presence means "was called": a blanket map rule would contradict it.
    expect(bullet).not.toMatch(/set of entries in a map-valued key/);
    expect(bullet).toMatch(/stated per key, not for every map/);
  });
});
