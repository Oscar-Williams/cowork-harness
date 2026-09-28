import { describe, it, expect } from "vitest";
import { diffSurfaces } from "../scripts/check-surface.js";

// Widening a scalar field into a union that KEEPS the prior scalar arm (`tool_called: <glob>` becoming
// `<glob> | {object}`) is additive: every document the old schema accepted still validates. The raw path
// diff shows the scalar leaf moving under `<anyOf:0>` as a removal, which read as a breaking change.
const base = { schemas: { "s.json": { ".assert[].tool_called": { type: "string" } } } };

describe("diffSurfaces: a union that keeps the prior scalar arm is additive", () => {
  it("scalar → anyOf[scalar, object] is +N -0", () => {
    const cur = {
      schemas: {
        "s.json": {
          ".assert[].tool_called<anyOf:0>": { type: "string" },
          ".assert[].tool_called<anyOf:1>": { type: "object", closed: true },
          ".assert[].tool_called<anyOf:1>.tool": { required: true },
        },
      },
    };
    const d = diffSurfaces(base, cur);
    expect(d.removed).toEqual([]);
    expect(d.changed).toEqual([]);
    expect(d.ok).toBe(true);
    expect(d.added.length).toBeGreaterThan(0);
    expect(d.widened).toEqual(["schemas.s.json..assert[].tool_called.type"]);
  });

  it("a union that DROPS the prior scalar type is still a removal", () => {
    const cur = {
      schemas: { "s.json": { ".assert[].tool_called<anyOf:0>": { type: "number" }, ".assert[].tool_called<anyOf:1>": { type: "object" } } },
    };
    const d = diffSurfaces(base, cur);
    expect(d.removed).toEqual(["schemas.s.json..assert[].tool_called.type"]);
    expect(d.ok).toBe(false);
  });

  it("a plain removal is still a removal", () => {
    const d = diffSurfaces(base, { schemas: { "s.json": {} } });
    expect(d.ok).toBe(false);
  });
});

describe("diffSurfaces: a list of names is a set, not a positional array", () => {
  it("inserting one env var is +1 -0 ~0, not a cascade of 'changed' indexes", () => {
    const d = diffSurfaces({ env: { coworkVars: ["A", "C", "D"] } }, { env: { coworkVars: ["A", "B", "C", "D"] } });
    expect(d).toMatchObject({ added: ["env.coworkVars[B]"], removed: [], changed: [], ok: true });
  });
  it("removing one is still a removal", () => {
    expect(diffSurfaces({ env: { coworkVars: ["A", "B"] } }, { env: { coworkVars: ["A"] } }).removed).toEqual(["env.coworkVars[B]"]);
  });
});
