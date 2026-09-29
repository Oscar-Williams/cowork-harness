/**
 * Does an assertion REGEX name a literal of the kind cassette redaction rewrites?
 *
 * Why it matters: a committed cassette is redacted, which rewrites the frozen tool inputs but not a regex
 * an author later points at them (`replay --assert-from`). A NEGATIVE check such as
 * `tool_not_called: {input: {command: 'rm\s+-rf\s+/Users/acme'}}` then looks for bytes that no longer
 * exist and passes vacuously. This is the offline heuristic for "the policy would rewrite this literal":
 * the SHAPES the reference policy (`.cowork-redact.json`, `init-redact`) scrubs — home and temp paths,
 * mount roots, and email addresses. `scenario.py`'s `tool-input-regex-redactable` lint keeps a Python
 * copy of the same shapes; the record-time comparison (`redactedNegativeInputMatches`) is the exact guard.
 */

/** Every redaction token, in every form the harness writes: the content-redaction policy's
 *  `[REDACTED:<label>:<hash>]` (src/redact.ts `token()`), and the operator-secret scrubber's colon-less
 *  `[REDACTED]` plus its whole-field `[REDACTED:base64]` / `[REDACTED:uri]` (src/secrets.ts). The scrubber
 *  runs over result.json and events.jsonl, so its tokens reach every cassette and every verify-run. */
export const REDACTION_TOKEN_RE = /\[REDACTED(?::[^\]]*)?\]/g;

/** Does this text carry a redaction token of any form? */
export function hasRedactionToken(text: string): boolean {
  return /\[REDACTED(?::|\])/.test(text);
}

const REDACTABLE_SHAPES: RegExp[] = [
  /\/(?:Users|home|root)\/[^/\s]/,
  // Still matches `/private/var/empty`, which the reference policy keeps: this is a "might be redacted"
  // heuristic, and over-warning on that one system path is its safe side.
  /\/private\/(?:tmp|var)\//,
  /\/var\/folders\//,
  /\/Volumes\/[^/\s]/,
  /\/System\/Volumes\//,
  // A Claude project slug: a path with each `/` turned into `-` (`-Users-acme-repo`), as the shipped policy's
  // slug rule rewrites.
  /(?:^|[/"'\s])-(?:Users|home|root)-[^/\s]/,
  // An Anthropic key: the operator-secret scrubber (src/secrets.ts) rewrites the whole key to [REDACTED].
  /sk-ant-/,
  /[A-Za-z0-9._%+-]@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
];

/** Un-escape a regex source to its literal reading (`\/` → `/`, `\.` → `.`), so `\/Users\/acme` and
 *  `/Users/acme` are judged alike. Crude on purpose: a character class or group still reads as its
 *  characters, which can only make the check fire MORE — the safe direction for a warning. */
function literalReading(source: string): string {
  return source.replace(/\\(.)/g, "$1");
}

export function regexNamesRedactableLiteral(source: string): boolean {
  const lit = literalReading(source);
  return REDACTABLE_SHAPES.some((re) => re.test(lit));
}
