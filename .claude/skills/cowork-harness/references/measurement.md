# Measurement

Tracks `cowork-harness 3.10.0` (baseline `desktop-2.9939.2`). Read it before comparing runs: `--repeat`, `--ablate-skill`, and the hygiene that keeps a batch valid.

### Measure — before/after, with/without (`--repeat`, `--ablate-skill`)

A single green proves the run passed **once**. Two questions need more than that, and both have a
discipline that is cheap to follow and expensive to skip.

**"Did it pass, or pass once?"** → `--repeat N` (2-100, on `skill` AND `run`) samples the same
skill+prompt N times and prints a variance rollup instead of a single verdict. `--min-pass-rate` sets
the batch threshold, `--stop-on-diverge` stops the moment flakiness is proven, `--max-budget-usd` caps
spend.

**"Does the skill actually help?"** → `--ablate-skill` runs the prompt with every skill/plugin
discovery source removed, so the agent answers from its own priors. **It is ONE arm, not a paired
experiment**: this invocation is the control. Run the same prompt a second time *without* the flag for
the treatment arm and compare them yourself. Composed with `--repeat 5` it produces **5 ablated runs
and 0 treatment runs** — N samples of the control, which is the intended reading and is not an A/B.
The rollup says so on its verdict line: `repeat "<skill>": PASS [ABLATED — control arm] — 5/5 passed`.
Every ablated run is stamped `ablated: true` in `result.json` and carries `ablated=true` on its
`[provenance]` footer line; a run that isn't stamped is a real run.
What the harness gives you here is the run execution and the control arm — designing the comparison
(scrubbing giveaways, shuffling, judging blind, unblinding only after grading) is still yours.

### Tool timing — what `toolDurations` measures

`result.json`'s `toolDurations` and `trace <run> --view tool-durations` report, per tool, the **wall gap
from `tool_use` to `tool_result`** as the harness saw them (`toolDurationsBasis: "wall_gap"`). That gap
includes model/transport and permission latency, and an `Agent`/`Task` entry spans its whole sub-agent
run, so it is not execution time and summing it across tools double-counts. `calls`, `totalMs` and
`maxMs` cover paired calls only; `unpaired` counts calls never paired with a `tool_result` the harness observed, which have no duration.
The fold covers main-agent and sub-agent calls alike, where observed (microvm sub-agent result delivery is unobserved). Narrow the trace view with `--scope main|subagent`,
which reads the run's own classification from `result.json`, and add `--per-call` for one row per call.
Compare timings between runs of the same tier and model only.

**Measurement hygiene — four things that silently invalidate a batch:**

1. **Pin the model.** With no `model:` in the session (or `--model` on the `skill` lane) the run uses
   whatever the staged agent binary defaults to — not a harness constant, and it can move under a
   baseline bump. Read `result.json`'s `models` back before believing any cross-run comparison — and when
   you do, **ignore any entry wrapped in angle brackets**: `<synthetic>` is the agent marking a turn it
   fabricated locally (no API call), not a model, so two runs of the same pinned model can differ on this
   array purely by whether such a turn occurred.
2. **Freeze a recoverable source first**: commit it, or snapshot the skill folder next to the run dir.
   `fingerprint.skillHash` is content-exact but one-way, so an edit mid-batch silently splits your
   dataset into two generations — and a hash whose source was never frozen identifies a generation that
   is unrecoverable. `stats --group-by skill-hash` separates them after the fact; nothing recovers the
   source.
3. **Check which arm you actually ran** before analysing anything: `ablated` and
   `context.availableSkills` in each `result.json`.
4. **Classify each rep three ways**: invocation (`skillsInvoked`), observed source access (did it read
   `SKILL.md` directly?) and answer quality. "Not invoked" is not "answered from priors" outside the
   ablated arm — see [Recipe 5](./task-recipes.md), step 3.
