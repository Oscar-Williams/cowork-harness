import { describe, it, expect } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

// Which image the egress sidecar actually runs, observed through the sidecar path itself rather than a
// resolver unit test. The CLI statically imports the sidecar module (cli → chat → sidecar) and only then
// loads `.env` inside main(), so a value read at module-load time is fixed before `.env` is applied: the
// sidecar would ignore a `.env` COWORK_PROXY_IMAGE that `doctor` honours. Each case runs in a child node
// process against the REAL source (via tsx) in that same order — static import first, `.env` second —
// with COWORK_CONTAINER_RUNTIME pointed at a fake runtime that records its argv and reports the proxy as
// running. No Docker, no network.

const POSIX = process.platform !== "win32";
const SIDECAR = JSON.stringify(resolve("src/egress/sidecar.ts"));
const DOTENV = JSON.stringify(resolve("src/dotenv.ts"));

const FAKE_RUNTIME = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_RUNTIME_LOG"
if [ "$1" = "inspect" ] && [ "$3" = "{{.State.Running}}" ]; then echo true; fi
exit 0
`;

/** Run startEgressSidecar in a child process and return the image ref it passed to `image inspect` and
 *  to `run -d`. `dotenv` (when given) is written to a file the child loads AFTER importing the sidecar. */
function sidecarImage(opts: { env: Record<string, string | undefined>; dotenv?: string }): { inspect?: string; run?: string } {
  const dir = mkdtempSync(join(tmpdir(), "proxy-image-"));
  const runtime = join(dir, "fake-runtime");
  writeFileSync(runtime, FAKE_RUNTIME);
  chmodSync(runtime, 0o755);
  const log = join(dir, "argv.log");
  const envFile = join(dir, ".env");
  if (opts.dotenv !== undefined) writeFileSync(envFile, opts.dotenv);
  const script = join(dir, "harness.mts");
  writeFileSync(
    script,
    `
      import { startEgressSidecar } from ${SIDECAR};
      import { loadDotenv } from ${DOTENV};
      loadDotenv(${JSON.stringify(envFile)});
      const s = startEgressSidecar([], ${JSON.stringify(join(dir, "out"))}, "t1");
      s.teardown();
    `,
  );
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "COWORK_PROXY_IMAGE") env[k] = v;
  for (const [k, v] of Object.entries(opts.env)) if (v !== undefined) env[k] = v;
  env.COWORK_CONTAINER_RUNTIME = runtime;
  env.FAKE_RUNTIME_LOG = log;
  const r = spawnSync(process.execPath, ["--import", "tsx", script], { encoding: "utf8", timeout: 20_000, env });
  expect(r.status, r.stderr).toBe(0);
  expect(existsSync(log), "the fake runtime was never invoked").toBe(true);
  const lines = readFileSync(log, "utf8").split("\n");
  // `image inspect <ref>` — the ref is the last token (may be empty when an empty ref is passed through).
  const inspectLine = lines.find((l) => l.startsWith("image inspect"));
  const runLine = lines.find((l) => l.startsWith("run -d "));
  return {
    inspect: inspectLine === undefined ? undefined : inspectLine.slice("image inspect".length).trim(),
    run: runLine === undefined ? undefined : runLine.trim().split(" ").pop(),
  };
}

describe.runIf(POSIX)("egress sidecar honours COWORK_PROXY_IMAGE at use time", () => {
  // The default's exact value is pinned by the resolver's unit tests (test/agent-image.test.ts); here it is
  // only required to be a proxy tag, so this file needs nothing new from src/ and a red names the
  // behaviour, not a missing export.
  it("unset → the default proxy tag", () => {
    const got = sidecarImage({ env: {} });
    expect(got.inspect).toMatch(/^cowork-egress-proxy:\d+$/);
    expect(got.run).toBe(got.inspect);
  });

  it("set in the environment → that value", () => {
    const got = sidecarImage({ env: { COWORK_PROXY_IMAGE: "my-proxy:env" } });
    expect(got).toEqual({ inspect: "my-proxy:env", run: "my-proxy:env" });
  });

  it("set only in a .env loaded AFTER the sidecar module was imported → that value", () => {
    const got = sidecarImage({ env: {}, dotenv: "COWORK_PROXY_IMAGE=my-proxy:dotenv\n" });
    expect(got).toEqual({ inspect: "my-proxy:dotenv", run: "my-proxy:dotenv" });
  });

  it("an empty or blank value falls back to the default, never an empty image ref", () => {
    const unset = sidecarImage({ env: {} });
    expect(unset.inspect).toMatch(/^cowork-egress-proxy:\d+$/);
    expect(sidecarImage({ env: { COWORK_PROXY_IMAGE: "" } })).toEqual(unset);
    expect(sidecarImage({ env: { COWORK_PROXY_IMAGE: "   " } })).toEqual(unset);
  });
});
