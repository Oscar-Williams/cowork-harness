// The pure half of the live lane's model pin: no side effects on import, so a unit test can load it without
// touching its own worker's environment. test/setup/live-model.ts is the setup file that applies it.
export const LIVE_DEFAULT_MODEL = "claude-sonnet-5";

/** Set COWORK_HARNESS_MODEL to the live default when it is unset or empty; an explicit value wins. */
export function applyLiveModelDefault(env: NodeJS.ProcessEnv): void {
  if (!env.COWORK_HARNESS_MODEL) env.COWORK_HARNESS_MODEL = LIVE_DEFAULT_MODEL;
}
