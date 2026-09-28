// Compares the current structured surface (schema/*.json, action.yml IO, documented COWORK_* env
// vars — see scripts/lib/surface.ts) against the committed test/fixtures/surface-baseline.json and
// categorizes the diff into additions / removals / changes.
//
//   npx tsx scripts/check-surface.ts
//
// Pre-1.0, drift detection lives in test/surface-contract.test.ts as a plain snapshot-sync assertion
// — ANY diff (including a pure addition) fails that test, forcing a conscious `npm run gen:surface`
// regen + review before it ships. This script/module is the FUTURE 1.0 upgrade path: at 1.0, switch
// the test to call checkSurface() and hard-fail only on `removed`/`changed` — a pure `added` result
// is fine without a major bump, since additions aren't a compatibility break.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { computeSurface } from "./lib/surface.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = join(REPO_ROOT, "test/fixtures/surface-baseline.json");

export interface SurfaceDiff {
  ok: boolean;
  added: string[];
  removed: string[];
  changed: string[];
  /** Removed scalar leaves that survive as an arm of a new union at the same path (`X.type` → `X<anyOf:k>.type`
   *  with the same value): a widening, not a removal. Reported for review, never counted as breaking. */
  widened: string[];
}

/** Flatten an arbitrarily-nested JSON-able value into dotted/bracketed leaf paths -> a stable string
 *  value, so two surfaces can be diffed key-by-key regardless of nesting shape. A list of PRIMITIVES (the
 *  env-var names, an `enum`) is a set: each member becomes its own `[value]` leaf, so inserting one name
 *  is one addition rather than a cascade of shifted positional indexes reported as "changed". */
function flatten(value: unknown, prefix: string, out: Map<string, string>): void {
  if (value === null || typeof value !== "object") {
    out.set(prefix, JSON.stringify(value));
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      out.set(prefix, "[]");
      return;
    }
    if (value.every((v) => v === null || typeof v !== "object")) {
      for (const v of value) out.set(`${prefix}[${typeof v === "string" ? v : JSON.stringify(v)}]`, "true");
      return;
    }
    value.forEach((item, i) => flatten(item, `${prefix}[${i}]`, out));
    return;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 0) {
    out.set(prefix, "{}");
    return;
  }
  for (const key of keys) flatten(obj[key], prefix ? `${prefix}.${key}` : key, out);
}

/** Pure diff of two surfaces. `added` (a new leaf path) is fine at 1.0; `removed` and `changed` are
 *  breaking. A scalar leaf that moved under a union arm with the SAME value (`a.b.type` → `a.b<anyOf:0>.type`)
 *  is a widening — the old shape is still accepted — so it goes to `widened`, not `removed`. */
export function diffSurfaces(baseline: unknown, current: unknown): SurfaceDiff {
  const baseFlat = new Map<string, string>();
  const curFlat = new Map<string, string>();
  flatten(baseline, "", baseFlat);
  flatten(current, "", curFlat);

  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  const widened: string[] = [];

  for (const [path, curVal] of curFlat) {
    if (!baseFlat.has(path)) added.push(path);
    else if (baseFlat.get(path) !== curVal) changed.push(path);
  }
  for (const [path, baseVal] of baseFlat) {
    if (curFlat.has(path)) continue;
    // `…<parent>.<leafKey>` → is there a `…<parent><anyOf|oneOf:k>.<leafKey>` with the same value?
    const dot = path.lastIndexOf(".");
    const parent = dot === -1 ? "" : path.slice(0, dot);
    const leafKey = dot === -1 ? path : path.slice(dot + 1);
    const armRe = new RegExp(
      `^${parent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}<(?:anyOf|oneOf):\\d+>\\.${leafKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
    );
    const keptAsArm = [...curFlat].some(([p, v]) => v === baseVal && !baseFlat.has(p) && armRe.test(p));
    (keptAsArm ? widened : removed).push(path);
  }

  added.sort();
  removed.sort();
  changed.sort();
  widened.sort();

  return { ok: removed.length === 0 && changed.length === 0, added, removed, changed, widened };
}

/** Compare computeSurface() against the committed baseline. */
export function checkSurface(): SurfaceDiff {
  return diffSurfaces(JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as unknown, computeSurface() as unknown);
}

function main(): void {
  const { ok, added, removed, changed, widened } = checkSurface();
  process.stdout.write(`surface diff: +${added.length} -${removed.length} ~${changed.length}\n`);
  if (added.length) process.stdout.write(`  added:   ${added.join(", ")}\n`);
  if (widened.length) process.stdout.write(`  widened (scalar kept as a union arm — additive): ${widened.join(", ")}\n`);
  if (removed.length) process.stderr.write(`::error::removed: ${removed.join(", ")}\n`);
  if (changed.length) process.stderr.write(`::error::changed: ${changed.join(", ")}\n`);
  if (ok) {
    process.stdout.write("✓ no breaking surface changes\n");
    return;
  }
  process.exitCode = 1;
}

// Run only when invoked directly (so a test can import checkSurface without side effects).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
