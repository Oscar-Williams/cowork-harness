import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { shippedDocs } from "../scripts/check-versions.js";

// Shipped docs cite code by symbol, step name or key — never by line number. Every `file:line` citation the
// docs carried had rotted: a guard's CI step moved down the workflow, a schema description moved down the
// file, a `throw` moved by one line. The reader is sent to the wrong place with nothing to tell them so.
//
// The corpus is check:versions' shipped-doc set (the same one its invariants scan; CHANGELOG.md, test
// fixtures and captured prompt text are outside it) plus llms.txt. Fenced code blocks are skipped, since
// they may quote tool output such as `scenario.yaml:12: …`, and so are URLs, where `host.sh:8080` is a port.

const CITATION = /(?<![\w./-])[\w./-]+\.(?:ts|js|mjs|py|json|ya?ml|sh|md):\d+/g;

function citations(text: string): { line: number; hit: string }[] {
  const hits: { line: number; hit: string }[] = [];
  let fenced = false;
  text.split("\n").forEach((raw, i) => {
    // A fence may open on a list-item line ("- ```", "1. ```").
    if (/^\s*(?:[-*+]\s+|\d+[.)]\s+)?(```|~~~)/.test(raw)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    for (const m of raw.replace(/https?:\/\/\S+/g, "").matchAll(CITATION)) hits.push({ line: i + 1, hit: m[0] });
  });
  return hits;
}

describe("shipped docs carry no file:line citations", () => {
  it("the matcher finds a citation, and skips fences and URLs (a dead regex would pass everything)", () => {
    expect(citations("see `.github/workflows/ci.yml:34-43` and src/cli.ts:899")).toEqual([
      { line: 1, hit: ".github/workflows/ci.yml:34" },
      { line: 1, hit: "src/cli.ts:899" },
    ]);
    expect(citations("```\nscenario.yaml:12: bad key\n```\nsee http://proxy.sh:8080/x")).toEqual([]);
    expect(citations("- ```\n  scenario.yaml:12: bad key\n  ```\n1. ```text\n   run.yaml:3: x\n   ```")).toEqual([]);
  });

  it("no shipped doc cites a line number", () => {
    const docs = shippedDocs(["llms.txt"]);
    expect(docs.length, "the shipped-doc corpus is near-empty").toBeGreaterThan(20);
    expect(docs.map((d) => d.path)).toContain("llms.txt");
    const found = docs.flatMap(({ path, text }) => citations(text).map(({ line, hit }) => `${path}:${line} cites ${hit}`));
    expect(found, "cite the symbol, CI step name or schema key instead").toEqual([]);
  });

  it("every CI step docs/invariants.md names exists in ci.yml", () => {
    const ci = parseYaml(readFileSync(".github/workflows/ci.yml", "utf8")) as { jobs: Record<string, { steps?: { name?: string }[] }> };
    const steps = new Set(Object.values(ci.jobs).flatMap((j) => (j.steps ?? []).map((s) => s.name).filter(Boolean)));
    const cited = [...readFileSync("docs/invariants.md", "utf8").matchAll(/CI step `([^`]+)`/g)].map((m) => m[1]);
    expect(cited.length, 'docs/invariants.md names fewer than 3 guards as "CI step `<name>`"').toBeGreaterThanOrEqual(3);
    expect(cited.filter((n) => !steps.has(n))).toEqual([]);
  });
});
