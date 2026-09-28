// The unit lane must never launch a real agent. `executeScenario` refuses to go past its load-time checks
// into staging/launch while this flag is set, so a regression in a load-time refusal (a scenario that
// SHOULD have been refused) fails red here instead of silently launching a real run — possibly a paid
// one, since a host-loop agent can find the operator's own credentials. The live lane
// (vitest.config.live.ts) does not load this file.
//
// Only set when the caller has not set it, so a test file that needs a different value owns that choice.
if (process.env.COWORK_HARNESS_FORBID_SPAWN === undefined) process.env.COWORK_HARNESS_FORBID_SPAWN = "1";
