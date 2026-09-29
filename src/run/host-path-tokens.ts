// The host-path shape `hostPathLeaked` (src/run/execute.ts) looks for, as a TOKEN extractor. Kept in its
// own dependency-free module so the staging code (runtime/*) can tokenize input files without importing
// execute.ts, which imports the runtimes.

// A host root, preceded by a boundary: start of text, whitespace, a quote, `(`, `=`, `:`, a backtick, or a
// `file://` / `computer://` prefix with its optional authority. The roots and the boundary are exactly
// `hostPathLeaked`'s — see its doc comment in execute.ts for why each is there.
const BOUNDARY = String.raw`(^|[\s"'(=:` + "`" + String.raw`]|(?:file|computer):\/\/[^\s\/]*)`;
const ROOTS = String.raw`(\/Users\/|\/opt\/cowork\/|\/home\/|\/root\/|\/private\/var\/|\/private\/tmp\/|\/var\/folders\/|\/Volumes\/)`;
// The rest of the token, up to the first delimiter: whitespace, a quote, a backtick, `)`, `]`, `<`, `>`,
// `,`, `;` or a backslash (which ends a JSON-escaped line in raw text). A trailing `.` or `:` is NOT a
// delimiter, so a sentence-final path yields a token that no input file carries — the safe direction.
const TAIL = String.raw`([^\s"'` + "`" + String.raw`)\]<>,;\\]*)`;
const HOST_PATH_TOKEN_RE = new RegExp(BOUNDARY + ROOTS + TAIL, "g");

/** Decode each `%`-escape RUN independently (a stray `%`, as in `build 100% done`, would make a whole-text
 *  decodeURIComponent throw), then turn backslashes into slashes, so `%2FUsers%2F…` and `file:\\host\Users`
 *  are seen as the paths they spell. */
function decodedForm(text: string): string {
  const decoded = text.replace(/(?:%[0-9A-Fa-f]{2})+/g, (m) => {
    try {
      return decodeURIComponent(m);
    } catch {
      return m;
    }
  });
  return decoded.replace(/\\/g, "/");
}

function tokensIn(text: string, into: string[]): void {
  for (const m of text.matchAll(HOST_PATH_TOKEN_RE)) into.push(m[2] + m[3]);
}

/**
 * Every host-path token in `text`: each root match extended to the full path, from the raw text and — when
 * decoding changes it — from its decoded, backslash-normalized form too. Non-empty exactly when
 * `hostPathLeaked(text)` is true. Tokens are compared verbatim; a symlinked and a realpath spelling of one
 * location are different tokens (so neither exempts the other — the safe side).
 */
export function hostPathTokens(text: string): string[] {
  const out: string[] = [];
  tokensIn(text, out);
  const normalized = decodedForm(text);
  if (normalized !== text) tokensIn(normalized, out);
  return out;
}
