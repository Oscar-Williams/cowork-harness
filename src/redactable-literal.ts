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

/** Every redaction token starts with this (`[REDACTED:<label>:<hash>]`, src/redact.ts `token()`). */
export const REDACTION_TOKEN_MARK = "[REDACTED:";

const REDACTABLE_SHAPES: RegExp[] = [
  /\/(?:Users|home|root)\/[^/\s]/,
  /\/private\/(?:tmp|var)\//,
  /\/var\/folders\//,
  /\/Volumes\/[^/\s]/,
  /\/System\/Volumes\//,
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
