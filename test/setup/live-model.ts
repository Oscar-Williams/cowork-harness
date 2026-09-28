// The live lane pins a model. A run that resolves no model is refused, and the live suites drive the harness
// with inline sessions and bare `skill`/`critique` invocations, so they rely on COWORK_HARNESS_MODEL. This
// setup file runs in every live worker (vitest.config.live.ts `setupFiles`) and sets it when it is unset or
// empty. An explicit value wins, so a developer can run the lane on another model. Every harness spawn in a
// live suite passes `...process.env`, which carries the value (test/model-pin-live-lane.test.ts checks that).
export const LIVE_DEFAULT_MODEL = "claude-sonnet-5";

export function applyLiveModelDefault(env: NodeJS.ProcessEnv): void {
  if (!env.COWORK_HARNESS_MODEL) env.COWORK_HARNESS_MODEL = LIVE_DEFAULT_MODEL;
}

applyLiveModelDefault(process.env);
