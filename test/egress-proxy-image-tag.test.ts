import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { PROXY_IMAGE_DEFAULT } from "../src/runtime/agent-image.js";

const RESOLVER = join("src", "runtime", "agent-image.ts");

function srcFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...srcFiles(abs));
    else if (name.endsWith(".ts")) out.push(abs);
  }
  return out;
}

// The proxy image is built ONCE and then reused on tag existence alone (sidecar.ts's
// ensureProxyImage / doctor's image-inspect probe both short-circuit when the tag resolves). A change
// to Dockerfile.proxy therefore reaches nobody who has already built the previous tag -- their stale
// image keeps serving egress and doctor keeps calling it healthy. These two facts must move together.
describe("egress proxy image", () => {
  const dockerfile = readFileSync(resolve("docker/Dockerfile.proxy"), "utf8");

  it("builds on a Node line that still receives security patches", () => {
    const base = dockerfile.match(/^FROM\s+node:(\d+)-/m);
    expect(base, "expected a `FROM node:<major>-...` line").toBeTruthy();
    // 20 is EOL (2026-04-30). Raise this floor deliberately, never to silence a red test.
    expect(Number(base![1])).toBeGreaterThanOrEqual(22);
  });

  // The tag lives in ONE place — the exported constant — which every use site (the sidecar's
  // inspect/build/run and doctor's probe) reaches through resolveProxyImage. Read the value by import,
  // not by matching an expression's source text, so a refactor of the resolver cannot blind this check.
  it("the tag is past :2 — the last one built on the EOL base", () => {
    const tag = PROXY_IMAGE_DEFAULT.match(/^cowork-egress-proxy:(\d+)$/)?.[1];
    expect(tag, `unexpected PROXY_IMAGE_DEFAULT shape: ${PROXY_IMAGE_DEFAULT}`).toBeDefined();
    expect(Number(tag)).toBeGreaterThanOrEqual(3);
  });

  it("no src/ file other than the resolver spells a proxy tag", () => {
    // A second quoted `cowork-egress-proxy:<n>` literal is a second default that the digest guard below
    // would not move — the exact split this constant exists to prevent.
    const literal = /["'`]cowork-egress-proxy:\d+/g;
    const hits = srcFiles("src").flatMap((f) => (readFileSync(f, "utf8").match(literal) ?? []).map(() => f));
    expect(hits).toEqual([RESOLVER]);
  });

  // THE FORWARD GUARD. Everything above pins the CURRENT bump; this one pins the RULE. Because both
  // ensureProxyImage and doctor reuse an image on tag existence alone, any future edit to
  // Dockerfile.proxy that ships without a tag bump reaches nobody who already built the old tag —
  // silently, exactly the defect the :2 -> :3 move exists to correct. Changing the Dockerfile reds this
  // test; the fix is to bump the tag AND update this digest in the same commit, deliberately.
  it("Dockerfile.proxy has not changed without a matching tag bump", () => {
    const digest = createHash("sha256")
      .update(readFileSync(resolve("docker/Dockerfile.proxy")))
      .digest("hex");
    expect(
      digest,
      "docker/Dockerfile.proxy changed. If the change must reach existing installs (it almost always " +
        "must — they reuse the image on tag existence alone), bump cowork-egress-proxy:<n> in " +
        "src/runtime/agent-image.ts (PROXY_IMAGE_DEFAULT), then update this digest in the same commit.",
    ).toBe("f550ba73e1b27f3c761259e72785ee2cc79ef6a4657ce47d1522834e8aa5bd50");
  });
});
