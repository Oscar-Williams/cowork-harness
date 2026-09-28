import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { resolve, join, dirname, sep } from "node:path";

// Payload-resolution link check.
//
// The installed plugin ships ONLY the payload — .claude/skills/cowork-harness/{SKILL.md,
// references/*.md, scripts/*, evals/*}. A markdown link `](target)` whose target escapes that
// payload (../README.md, docs/foo.md, SPEC.md, ../../whatever) dangles for an installed agent,
// since none of docs/, README.md, SPEC.md ship with the plugin.
//
// Bare prose mentions ("see docs/foo.md (repo-only)") are fine — only actual markdown link
// targets `](...)` are checked. Anchor-only links (`](#foo)`) and links that stay inside the
// payload are fine too.

const REPO_ROOT = resolve(".");
const SKILL_DIR = resolve(".claude/skills/cowork-harness");

interface LinkTarget {
  file: string;
  raw: string;
}

function markdownLinkTargets(file: string): LinkTarget[] {
  const text = readFileSync(file, "utf8");
  const targets: LinkTarget[] = [];
  // Matches inline markdown links: ](target) — deliberately does NOT match bare "[text]"
  // with no parens, and does not match prose.
  const re = /\]\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    targets.push({ file, raw: m[1].trim() });
  }
  return targets;
}

function skillMarkdownFiles(): string[] {
  const refsDir = join(SKILL_DIR, "references");
  const refs = readdirSync(refsDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => join(refsDir, f));
  return [join(SKILL_DIR, "SKILL.md"), ...refs];
}

/** True if `target` is a link we don't need to check for payload-escape: anchor-only,
 *  or an absolute external URL / mailto / protocol-relative link. */
function isExempt(target: string): boolean {
  if (target === "" || target.startsWith("#")) return true;
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return true; // http(s):, mailto:, etc.
  return false;
}

describe("skill payload links stay inside the shipped payload", () => {
  const files = skillMarkdownFiles();
  expect(files.length).toBeGreaterThan(1); // sanity: SKILL.md + at least one reference doc

  const escapes: { file: string; raw: string; resolved: string }[] = [];

  for (const file of files) {
    for (const { raw } of markdownLinkTargets(file)) {
      if (isExempt(raw)) continue;

      // Strip a trailing #fragment before resolving the filesystem path.
      const withoutFragment = raw.split("#")[0];
      if (withoutFragment === "") continue; // e.g. "same-file.md#frag" with empty path — n/a here

      const resolved = resolve(dirname(file), withoutFragment);
      const insidePayload = resolved === SKILL_DIR || resolved.startsWith(SKILL_DIR + sep);

      // Belt-and-suspenders: also flag known repo-only targets even if path resolution
      // somehow didn't catch them (e.g. odd relative forms).
      const knownRepoOnly = /(^|\/)docs\//.test(raw) || /README(\.md)?($|#)/i.test(raw) || /SPEC\.md/.test(raw);

      if (!insidePayload || knownRepoOnly) {
        escapes.push({ file: file.replace(REPO_ROOT + sep, ""), raw, resolved: resolved.replace(REPO_ROOT + sep, "") });
      }
    }
  }

  it("no markdown link in SKILL.md or references/*.md resolves outside the payload", () => {
    expect(
      escapes,
      escapes
        .map((e) => `${e.file}: ](${e.raw}) resolves to ${e.resolved}, which is outside ${SKILL_DIR.replace(REPO_ROOT + sep, "")}`)
        .join("\n"),
    ).toEqual([]);
  });
});

// The check above asks only whether a link STAYS inside the payload — a prefix test, so a link that
// resolves to a path that does not exist still passes. That is exactly what moving a section out of
// SKILL.md into references/ produces: a moved `](references/x.md)` resolves to references/references/x.md,
// which is inside the payload and missing. So every in-payload link must also name a real file, and a
// #fragment must name a real heading in it (GitHub's slug rule, headings outside fenced blocks only).
function githubSlug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9 _-]/g, "")
    .replace(/\s/g, "-");
}

function headingSlugs(text: string): Set<string> {
  const out = new Set<string>();
  let inFence = false;
  for (const line of text.split("\n")) {
    if (/^(```|~~~)/.test(line.trim())) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = line.match(/^#{1,6}\s+(.*)$/);
    if (m) out.add(githubSlug(m[1].trim()));
  }
  return out;
}

describe("in-payload links resolve to a real file and heading", () => {
  const links = skillMarkdownFiles().flatMap((file) =>
    markdownLinkTargets(file)
      .filter(({ raw }) => !/^[a-z][a-z0-9+.-]*:/i.test(raw) && raw !== "")
      .map(({ raw }) => {
        const [path, frag] = raw.split("#");
        const target = path === "" ? file : resolve(dirname(file), path);
        return { file: file.replace(REPO_ROOT + sep, ""), raw, target, frag };
      })
      .filter((l) => l.target === SKILL_DIR || l.target.startsWith(SKILL_DIR + sep)),
  );

  it("found in-payload links to check (guards a vacuous pass)", () => {
    expect(links.filter((l) => !l.raw.startsWith("#")).length).toBeGreaterThan(0);
  });

  it("every in-payload link names a file that exists", () => {
    const missing = links.filter((l) => !existsSync(l.target) || !statSync(l.target).isFile());
    expect(missing.map((l) => `${l.file}: ](${l.raw}) -> ${l.target.replace(REPO_ROOT + sep, "")} does not exist`)).toEqual([]);
  });

  it("every #fragment names a heading in the linked file", () => {
    const broken = links.filter((l) => l.frag && existsSync(l.target) && !headingSlugs(readFileSync(l.target, "utf8")).has(l.frag));
    expect(broken.map((l) => `${l.file}: ](${l.raw}) — #${l.frag} is not a heading there`)).toEqual([]);
  });
});
