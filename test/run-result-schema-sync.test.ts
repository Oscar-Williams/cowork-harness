import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

// Keep schema/run-result.json in sync with the `RunResult` TYPE automatically. Rather than
// regenerate the hand-tuned §12 schema (its descriptions, permissive pass-through nodes, and loose
// arrays are deliberate), this DERIVES the type's top-level field set from src/types.ts via the TS
// compiler API and asserts the schema declares EXACTLY those fields — both directions. So a field added
// to (or removed from) the RunResult interface that isn't mirrored in the schema fails here, closing the
// "emitted-but-undeclared" / "stale schema property" drift without a fragile full generator.
//
// Complements run-result-schema.test.ts, which pins the VALUE shapes (a full RunResult validates against
// the schema, strictly). This test pins the NAME set.

function runResultFieldNames(): string[] {
  const src = readFileSync(resolve("src/types.ts"), "utf8");
  const sf = ts.createSourceFile("types.ts", src, ts.ScriptTarget.Latest, true);
  const fields: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === "RunResult") {
      for (const m of node.members) {
        if (ts.isPropertySignature(m) && m.name) fields.push(m.name.getText(sf));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return fields;
}

describe("schema/run-result.json ↔ RunResult type (name-level sync)", () => {
  const typeFields = runResultFieldNames().sort();
  const schema = JSON.parse(readFileSync(resolve("schema/run-result.json"), "utf8")) as { properties: Record<string, unknown> };
  const schemaProps = Object.keys(schema.properties).sort();

  it("parsed a sane RunResult field set (guards against a compiler-API change silently emptying this)", () => {
    expect(typeFields.length).toBeGreaterThan(50);
    expect(typeFields).toContain("scenario");
    expect(typeFields).toContain("assertions");
  });

  it("every RunResult type field is declared in the schema", () => {
    const missing = typeFields.filter((f) => !schemaProps.includes(f));
    expect(missing, `schema/run-result.json is missing these RunResult fields: ${missing.join(", ")}`).toEqual([]);
  });

  it("every schema property corresponds to a real RunResult field (no stale properties)", () => {
    const stale = schemaProps.filter((p) => !typeFields.includes(p));
    expect(stale, `schema/run-result.json declares properties the type no longer has: ${stale.join(", ")}`).toEqual([]);
  });
});

describe("SPEC.md's RunResult excerpt ↔ schema/run-result.json", () => {
  // SPEC.md shows an abridged RunResult: the fields most consumers branch on. One direction only — a key
  // SPEC omits is by design, but a key SPEC shows must still exist, so a rename or removal cannot leave the
  // old name in the contract document. The block must also say it is abridged and where the full list is,
  // or a reader takes the missing fields as absent.
  const ANCHOR = "**`RunResult`** (`src/types.ts`):";
  const spec = readFileSync(resolve("SPEC.md"), "utf8");
  const at = spec.indexOf(ANCHOR);
  const fence = spec.indexOf("```jsonc\n", at);
  const intro = spec.slice(at + ANCHOR.length, fence);
  const block = spec.slice(fence, spec.indexOf("\n```", fence + 1));
  const specKeys = [...block.matchAll(/^ {2}"([\w$]+)\??"\s*:/gm)].map((m) => m[1]);
  const schema = JSON.parse(readFileSync(resolve("schema/run-result.json"), "utf8")) as { properties: Record<string, unknown> };

  it("found the block (a moved anchor must fail loudly, not empty the check)", () => {
    expect(at, `SPEC.md no longer has the line ${ANCHOR}`).toBeGreaterThanOrEqual(0);
    expect(fence - at, "the RunResult anchor is no longer directly followed by its jsonc block").toBeLessThan(800);
    expect(specKeys.length).toBeGreaterThan(20);
  });

  it("every top-level key SPEC.md shows is a real schema property", () => {
    const stale = specKeys.filter((k) => !(k in schema.properties));
    expect(stale, `SPEC.md's RunResult block shows keys schema/run-result.json does not declare: ${stale.join(", ")}`).toEqual([]);
  });

  it("the block says it is abridged and names the schema file as the full list", () => {
    expect(intro).toMatch(/abridged/i);
    expect(intro).toContain("`schema/run-result.json`");
  });
});
