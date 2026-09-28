import { describe, it, expect } from "vitest";
import { regexNamesRedactableLiteral } from "../src/redactable-literal.js";

// The TS copy of the redactable-literal shapes (scenario.py keeps the Python copy). Positive-direction
// only now — a negative miss over redacted text is unknown regardless — so this picks the WORDING of a
// red, but the two lists must still agree.
describe("regexNamesRedactableLiteral", () => {
  it.each([
    "/Users/acme",
    "\\/home\\/bob",
    "/private/tmp/x",
    "/var/folders/ab",
    "alice@example\\.com",
    "projects/-Users-acme",
    "-home-bob-repo",
  ])("flags %s", (src) => expect(regexNamesRedactableLiteral(src)).toBe(true));
  it.each(["rm\\s+-rf", "git push", "outputs/report\\.md", "--Users"])("leaves %s alone", (src) =>
    expect(regexNamesRedactableLiteral(src)).toBe(false),
  );
});

describe("the operator-secret scrubber's shape", () => {
  it("flags an Anthropic key prefix", () => expect(regexNamesRedactableLiteral("sk-ant-")).toBe(true));
});
