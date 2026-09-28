/**
 * The unit-lane spawn guard. `test/setup/forbid-spawn.ts` sets COWORK_HARNESS_FORBID_SPAWN=1 for the fast
 * test lane; every place the harness launches a model calls this first — executeScenario at the top of its
 * stage/launch step, `chat --raw` before its `docker run`, and the `--decider-llm` transport before
 * `claude -p`. A test that reaches one of them fails red instead of launching a real agent (which, on the
 * host, can find the operator's own credentials and cost money).
 */
export function assertSpawnAllowed(what: string, env: NodeJS.ProcessEnv = process.env): void {
  const v = env.COWORK_HARNESS_FORBID_SPAWN;
  if (v !== undefined && v !== "" && v !== "0")
    throw new Error(
      `COWORK_HARNESS_FORBID_SPAWN is set: refusing to stage or launch an agent for ${what}. ` +
        `The unit test lane never runs a real agent — this call passed every check before the launch.`,
    );
}
