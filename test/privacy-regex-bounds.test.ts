import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { redactText, type RedactionPolicy } from "../src/redact.js";
import { scanText, DEFAULT_SCAN_PATTERNS } from "../src/scan.js";
import { normalizeHostShapedForReplay } from "../src/run/computer-links.js";

/**
 * The linear-time forms of the scanner's `email`/`domain` classes and the policy's `(?=/mnt/)` rules behave
 * exactly as the unbounded forms did up to a limit no real value reaches, and the tests below pin both sides of
 * each limit. Also pinned: the URL and query-value shapes the policy and the scanner now agree on.
 * Synthetic usernames only (`alice`, `bob`).
 */

const POLICY_JSON = JSON.parse(readFileSync(resolve(".cowork-redact.json"), "utf8")) as {
  patterns: { regex: string; label?: string; flags?: string }[];
};
const POLICY: RedactionPolicy = {
  patterns: POLICY_JSON.patterns.map((p) => ({ re: new RegExp(p.regex, p.flags ?? "g"), label: p.label ?? "redacted" })),
  keyNames: [],
};
const find = (cls: string) => (text: string) =>
  scanText(text, "t", [])
    .filter((f) => f.cls === cls)
    .map((f) => f.sample);
const emails = find("email");
const domains = find("domain");
const paths = find("path");

describe("email — no length limit where a real address starts, 64 characters elsewhere", () => {
  for (const len of [64, 65, 70, 300]) {
    const addr = "a".repeat(len) + "@x.com";
    it(`a ${len}-character local part at the start of a word is matched whole, and redacted whole`, () => {
      expect(emails(`mail ${addr} ok`)).toEqual([addr]);
      expect(redactText(`mail ${addr} ok`, POLICY)).toMatch(/^mail \[REDACTED:email:[0-9a-f]{12}\] ok$/);
    });
  }
  it("a long base64 run glued to an address leaves nothing of it in clear text", () => {
    const s = "A".repeat(200) + "+alice@example.org";
    expect(emails(s)).toEqual([s]);
    expect(redactText(s, POLICY)).toMatch(/^\[REDACTED:email:[0-9a-f]{12}\]$/);
  });
  it("two adjacent addresses are both found and both redacted", () => {
    expect(emails("a@x.com+b@y.com")).toEqual(["a@x.com", "+b@y.com"]);
    const red = redactText("a@x.com+b@y.com", POLICY);
    expect(red).toMatch(/^\[REDACTED:email:[0-9a-f]{12}\]\[REDACTED:email:[0-9a-f]{12}\]$/);
    expect(emails(red)).toEqual([]);
  });
  it("an address glued to the end of another, with a local part over 64 characters, is matched on its last 64", () => {
    // The only shape where the bounded form differs from the unbounded one: the second local part does not
    // start a word (it continues the first address's domain), so it gets the 64-character window; anything
    // before that window stays in clear text. Here the name sits inside the window, so it is redacted.
    const s = "a@b.io+" + "x".repeat(64) + ".alice@y.io";
    expect(emails(s)).toEqual(["a@b.io", "x".repeat(58) + ".alice@y.io"]);
    const red = redactText(s, POLICY);
    expect(red).not.toContain("alice");
    expect(red).not.toContain("y.io");
  });
  it("…and anything before the 64-character window stays in clear text, unflagged (documented residue)", () => {
    // A name at the HEAD of a glued local part over 64 characters falls outside the window. The residue has
    // no `@`, so the scanner does not see it after redaction either. Pinned so the limit stays a decision.
    const s = "a@b.io+alice." + "x".repeat(65) + "@y.io";
    const red = redactText(s, POLICY);
    expect(red).toMatch(/^\[REDACTED:email:[0-9a-f]{12}\]\+alice\.x+\[REDACTED:email:[0-9a-f]{12}\]$/);
    expect(emails(red)).toEqual([]);
  });
});

describe("domain — a label is at most 63 characters", () => {
  it("flags a 63-character label", () => {
    expect(domains("a".repeat(63) + ".com")).toHaveLength(1);
  });
  it("does not flag a 64-character label (not a valid hostname)", () => {
    expect(domains("a".repeat(64) + ".com")).toEqual([]);
    expect(domains("id=" + "0123456789abcdef".repeat(4) + "acme.com")).toEqual([]);
  });
});

describe("policy `(?=/mnt/)` rules — keep the /mnt/ tail for up to 1024 characters between the root and /mnt/", () => {
  const link = (len: number) => `[v](computer:///Users/alice/${"x".repeat(len)}/mnt/outputs/f.md)`;
  it("1024 characters after the root still redact to a token followed by the /mnt/ tail", () => {
    // after the root "/Users/": "alice/" (6) + 1018 filler characters = exactly 1024
    const red = redactText(link(1018), POLICY);
    expect(red).not.toContain("alice");
    const target = red.slice(red.indexOf("computer://") + "computer://".length, -1);
    expect(normalizeHostShapedForReplay(target, undefined)).toBe("outputs/f.md");
  });
  it("past 1024 the whole path is redacted: no username, and the link no longer resolves (fails safe)", () => {
    const red = redactText(link(1019), POLICY);
    expect(red).not.toContain("alice");
    expect(red).not.toContain("/mnt/");
  });
  it("past 1024 with a second root inside, no username survives (one stray `]`, the link still resolves)", () => {
    const red = redactText(`[v](computer:///Users/alice/${"x".repeat(1100)}/Users/bob/x/mnt/outputs/f.md)`, POLICY);
    expect(red).not.toMatch(/alice|bob/);
    expect(red).toMatch(/\]\]\/mnt\/outputs\/f\.md\)$/);
  });
});

describe("a host path right after `http(s)://` with no host", () => {
  for (const s of ["at https:///Users/alice/f", "at HTTPS:///USERS/alice/f", "at http:///home/alice/x"])
    it(`is redacted: ${s}`, () => {
      expect(paths(s).length).toBeGreaterThan(0);
      const red = redactText(s, POLICY);
      expect(red).not.toContain("alice");
      expect(paths(red)).toEqual([]);
    });
  // The documented exception: a `:` before the root inside an http(s) URL. The scanner's `:`, `://` and
  // `file://` arms flag it; the policy's URL look-back keeps `:` (or a port URL's path would be rewritten).
  for (const s of [
    "at https://x.test:/Users/alice/f",
    "at https://h/file:///Users/alice/x",
    "at https://h/computer:///Users/alice/x",
    "at https://a:///Users/alice/f",
  ])
    it(`a \`:\` before the root inside a URL is flagged by the scanner and left by the policy: ${s}`, () => {
      expect(paths(s).length).toBeGreaterThan(0);
      expect(redactText(s, POLICY)).toBe(s);
    });
  for (const s of ["GET https://x/users/y", "GET https://api.example.com:8443/users/octocat/repos"])
    it(`a URL path is still left alone: ${s}`, () => {
      expect(redactText(s, POLICY)).toBe(s);
      expect(paths(s)).toEqual([]);
    });
});

describe("a slugged home segment in a URL query value", () => {
  for (const s of ["open http://localhost:3000/open?f=/tmp/claude-501/-Users-alice-x/f", "see https://x.test/?a=b/-Users-alice-x"])
    it(`is flagged and redacted: ${s}`, () => {
      expect(paths(s).length).toBeGreaterThan(0);
      const red = redactText(s, POLICY);
      expect(red).not.toContain("alice");
      expect(paths(red)).toEqual([]);
    });
  it("a slug in a URL path segment is still neither", () => {
    const s = "see https://h.test/p/-Users-alice-code-x/edit";
    expect(paths(s)).toEqual([]);
    expect(redactText(s, POLICY)).toBe(s);
  });
  it("the scanner and the policy stop their URL look-back at the same characters", () => {
    // Both layers skip a slug inside an http(s) URL by looking back for `http(s)://` over a class that ends
    // the URL. If the classes drift, one layer flags what the other leaves (or the reverse).
    const lookBack = (src: string) => /\(\?<!https\?:(?:\\\/|\/){2}\[\^([^\]]*)\]\{0,256\}\)\(\?<=\^/.exec(src)?.[1];
    const scan = lookBack(DEFAULT_SCAN_PATTERNS.find((p) => p.cls === "path")!.re.source);
    const policy = lookBack(POLICY_JSON.patterns.find((p) => p.regex.includes("-(?:Users|home|root)-"))!.regex);
    expect(scan).toBeDefined();
    expect(scan).toBe(policy);
  });
});

describe("the scanner flags a root after `,`, `|` or `<`, and the policy redacts it", () => {
  it("the scanner's root boundary and the policy's `/Volumes/` boundary are the same class", () => {
    // `/Volumes/` is the one policy root with a leading boundary (a Docker `…/volumes/…` segment must not
    // match). It must accept exactly what the scanner accepts, or the scanner flags what the policy leaves.
    const boundary = (src: string) => /\(\?<!\[\^([^\]]*\\\[[^\]]*)\]\)/.exec(src)?.[1];
    const scan = boundary(DEFAULT_SCAN_PATTERNS.find((p) => p.cls === "path")!.re.source);
    const volumes = POLICY_JSON.patterns.filter((p) => p.regex.includes("/Volumes/[") && !p.regex.startsWith("(?<!https"));
    expect(volumes).toHaveLength(2);
    expect(scan).toBeDefined();
    for (const p of volumes) expect(boundary(p.regex)).toBe(scan);
  });
  for (const s of [
    "a,/Users/alice/x",
    "x|/Users/alice/x",
    "</Users/alice/x>",
    "sed 's|/Users/alice|/home/bob|' f",
    "a,/Volumes/alice/x",
    "x|/Volumes/alice/x",
    "</Volumes/alice/x>",
    "sed 's|/Volumes/alice|/tmp/x|' f",
    "a,/System/Volumes/Data/Users/alice/p/f.md",
    "x|/System/Volumes/Data/Users/alice/p/f.md",
    "</System/Volumes/Data/Users/alice/p/f.md>",
  ])
    it(`${s}`, () => {
      expect(paths(s).filter((p) => p.includes("alice"))).toHaveLength(1);
      const red = redactText(s, POLICY);
      expect(red).not.toContain("alice");
      expect(paths(red)).toEqual([]);
    });
  it("a URL path with `,` before a root-like segment is flagged, and the policy rewrites it too", () => {
    // `,` ends the policy's URL look-back and is a scanner boundary, so both layers treat the segment as a path.
    const s = "https://x.test/a,/users/x";
    expect(paths(s)).toEqual(["/users/x"]);
    expect(redactText(s, POLICY)).not.toBe(s);
    expect(paths(redactText(s, POLICY))).toEqual([]);
  });
  it("plain prose with those characters stays clean", () => {
    expect(paths("a,b x|y <b>")).toEqual([]);
  });
});

describe("`*` is not a scanner root boundary (it would flag globs); the policy rewrites both shapes", () => {
  it("a glob is not flagged by the scanner, and is rewritten by the policy", () => {
    const s = "include: src/**/users/**";
    expect(paths(s)).toEqual([]);
    expect(redactText(s, POLICY)).not.toBe(s);
  });
  it("a bold-wrapped host path is not flagged by the scanner, but the policy redacts it", () => {
    const s = "Saved to **/Users/alice/proj/report.md** now";
    expect(paths(s)).toEqual([]);
    expect(redactText(s, POLICY)).not.toContain("alice");
  });
});

describe("over-redaction kept on purpose (fails safe)", () => {
  it("a URL path with a route group before a root-like segment is rewritten", () => {
    const s = "https://github.com/o/r/blob/main/app/(auth)/users/page.tsx";
    expect(redactText(s, POLICY)).not.toBe(s);
  });
});
