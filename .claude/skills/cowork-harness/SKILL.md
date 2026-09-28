---
name: cowork-harness
description: Test or debug a Claude Code skill/plugin under Claude Cowork's runtime — sandboxed agent, default-deny egress, the can_use_tool permission/question protocol — using the cowork-harness CLI. Use when validating or regression-testing a skill, authoring or debugging a scenario YAML (prompt + scripted answers + assert:), choosing a fidelity tier, scripting AskUserQuestion / tool-permission answers, or asserting artifacts, egress, or sub-agent dispatch. Especially when a harness run no-ops an assertion, fails on an unanswered gate, false-greens, a steered answer never reaches the model, or a web_fetch is unexpectedly denied or gated. Also when iterating or hardening a skill across fixes, or grounding a skill's self-critique against its own run evidence — including a document-analysis skill (cap table, deck, financial model, transcript) that needs an uploaded file attached to be critiqued at all. NOT for generic unit testing (pytest/vitest of your own scripts) or non-Cowork CI. Covers the skill / run / chat / record / replay / trace / decide / assertions / scaffold commands and the session-vs-scenario split.
metadata:
  author: cowork-harness
  version: 3.10.0
  tracks-harness: cowork-harness 3.10.0 (baseline desktop-2.9939.2)
---

# cowork-harness

This skill teaches you to drive the **`cowork-harness` CLI** — a fixture that runs a Claude Code
skill the way **Claude Cowork** runs it (sandboxed agent, default-deny egress, the permission /
AskUserQuestion control protocol). It is *not* the CLI itself: you still invoke `cowork-harness …`
in the shell; this skill tells you how to author scenarios, pick a fidelity tier, choose an answer
path, place assertions in the right CI lane, and avoid the harness's "✓ passed ≠ actually correct"
traps.

`cowork-harness` is an unofficial, independent project — not affiliated with or endorsed by
Anthropic. Say so if a user asks what it is.

The single most important idea: **a green run is not automatically a correct run.** The harness has
several ways to no-op a check while still producing a green run (skip an assertion on replay — now
flagged with a loud `::warning::`, not silent — auto-answer a gate, observe an empty egress
allowlist). This skill exists mostly to keep you out of those traps — the *Invariants* below and the
full landmine catalog in [`references/gotchas.md`](references/gotchas.md) are the highest-value part.
Read them.

> **Version note:** the facts and `file:line` pointers here track `cowork-harness 3.10.0` (baseline
> `desktop-2.9939.2`). If your checkout is newer, prefer the live `--help` and — in a repo checkout —
> `SPEC.md` / `docs/*.md` over this snapshot, and re-run the bundled linter.

## Preflight — make sure the harness can actually run

The 10-second inner loop, once the CLI is on PATH:

```bash
cowork-harness doctor                       # prerequisites OK? (Docker, agent, token, baseline)
cowork-harness skill ./my-skill "do X"      # run the skill once against the staged agent
```

Before the first command, confirm the CLI is reachable and **fail loud** (never fake a pass) when a tier's dependencies are missing:

- **One-shot check.** Run `cowork-harness doctor [--tier <tier>]` first — a read-only prerequisite check that inspects Docker, the staged agent, the token, and the baseline in one pass. The bullets below explain each thing it checks (and how to fix it).
- **Replay-only? Skip `doctor`.** Replaying committed cassettes needs no Docker, no staged agent, and no token — and every tier's `doctor` validates the auth token (the live tiers also Docker + the staged agent), so a ✗ there is expected, not a blocker. Go straight to `cowork-harness replay <cassette>`.
- **CLI on PATH, recent enough?** Run `cowork-harness --version` — this skill needs **≥ 3.10.0**. If it's missing or older, prefix every command with the version floor `npx "cowork-harness@^3.10.0" <cmd>` (Node ≥ 22), or install once with `npm i -g "cowork-harness@^3.10.0"`. **Pin `@^3.10.0`, never `@latest`** — `@latest` can silently fetch an older CLI and the new commands fail as "unknown command", whereas the floor **fails loud** if no compatible version is published.

  This skill documents the CURRENT surface, not release history. If `cowork-harness --version` is
  OLDER than the floor, the per-release record of what you are missing is [CHANGELOG.md](https://github.com/yaniv-golan/cowork-harness/blob/main/CHANGELOG.md)
  — upgrade rather than work around it, since this skill's `file:line` pointers and flag names track the floor.
- **Agent binary (sandboxed live tiers — `container`/`microvm`/`hostloop`/`cowork`).** The staged Claude Code agent is **bind-mounted** from a local Claude Desktop install, or point `COWORK_AGENT_BINARY` at a `claude-code-vm/<ver>/claude` ELF. Nothing is bundled. `protocol` (L0) and `replay` need no staged agent; for the sandboxed tiers, no agent → no run; report that, don't skip silently.
- **Docker / Lima.** Only `--fidelity protocol` (L0) runs without them. `container` / `microvm` / `hostloop` / `cowork` need Docker (Lima for L2). If they're absent, drop to `--fidelity protocol` and **say so** — a green that never exercised the sandbox is not a sandbox pass. At `protocol` the plugin under test **is** delivered (`--plugin-dir`), but its hooks then run as native host processes — so a plugin declaring hooks is refused there until you pass `--allow-host-hooks` / `allow_host_hooks: true`.
- **Auth.** `CLAUDE_CODE_OAUTH_TOKEN` (preferred), or `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`, via env or `.env`. Minting an OAuth token needs the **`claude` CLI** (`npm i -g @anthropic-ai/claude-code`, then `claude setup-token`).
- **`--dotenv` is a GLOBAL flag — put it BEFORE the subcommand.** `cowork-harness --dotenv .env record …`, never `cowork-harness record … --dotenv .env`. Every *other* flag is subcommand-level, so muscle memory fights this one; the harness rejects the misplaced form with an exact-fix error, but placing it first avoids the round-trip. **One exception: `critique` also accepts `--dotenv` per-command** (`critique <folder> --prompt "…" --dotenv <path>`) — available as of **1.6.0** (documented but unreachable before then); `--run-dir` stays global-only everywhere.

## Orient — the three loops

Everything you do with the harness is one of **three loops**, and the detail lives in one reference
file per loop: **author** a scenario ([`references/authoring.md`](references/authoring.md)), **run /
record / lock** it into a reproducible regression ([`references/run-record-replay.md`](references/run-record-replay.md)),
and **debug** a run that misbehaved or greened when it shouldn't ([`references/debugging.md`](references/debugging.md)).

Pick the entry point you need. The first three are the everyday path — a quick liveness check, the
CI-grade scenario, and the post-hoc debug loop; the rest are narrower tools that hang off them:

- **"Is it even alive?"** (inner loop) → `cowork-harness skill <folder> "<prompt>"`. Fastest; no
  scenario file.
- **Repeatable, asserted regression** → author a `scenarios/*.yaml` and run `cowork-harness run`.
  This is the CI-grade path and most of this skill.
- **A run failed — or greened and you don't trust it** (the debugging loop) → don't re-run and hope.
  The run already wrote its evidence to a **kept run dir** (`~/.cowork-harness/runs/…`; `--keep` prints
  the path, `trace <run-id>` finds it). **Localize the failure post-hoc** from that evidence:
  `cowork-harness trace <run-dir>`'s views + the emitted `result.json` to see what the run actually did,
  then `verify-run` to re-check a suspect assertion — all token-free, no Docker, no re-record. This is
  the loop 0.32.0's observability is built for; the *Triage* and *Inspecting a run's observability
  output* sections in [`references/debugging.md`](references/debugging.md) are the detail (the fuller human-facing map lives in
  [`docs/debugging.md`](https://github.com/yaniv-golan/cowork-harness/blob/main/docs/debugging.md) — repo-only, not shipped with the installed skill).
  **"Evidence" here means the RUN's own record** — events, trace, transcript. `critique`'s evaluator
  grades against a different artifact, `critique-evidence-package.txt`, which none of these tools
  surface; see `references/critique.md`.
- **Regression-test your skill's ANSWER quality** (not just its behavior — does its guidance still lead to
  correct answers after you edit it?) → author `semantic_matches` scenarios and gate on the per-claim
  profile. See **Recipe 5** in `references/task-recipes.md` (validity, N≥3, discrimination — the traps).
- **"What is WRONG with this skill?"** (a graded critique, not a pass/fail) → `cowork-harness critique
  <folder> --prompt "<probe>"`. Up to four model workloads (zero with `--corpus-only`; pass 2 is skipped with no self-report) and 10–20 minutes; budget from
  `report.costUsd.totalUsd`. Reach for it when you want **findings**. **For "what does this skill
  **DO**" — routing, artifact location, narration — use `skill` instead**: no evaluator, a fraction of
  the cost, and it answers that question directly. Report and evidence-package shapes:
  `references/critique.md`.
- **Multi-turn / interactive reproduction** → `cowork-harness chat` (interactive; gates answered at the
  TTY, **not** an asserted test — see *Debugging with `chat`* in `references/debugging.md`).
  **"Interactive" splits two ways — don't take the wrong branch.** Want to answer gates yourself *and*
  still get an asserted, `assert:`-checked run? That is `--decider-dir` (*Choose an answer path* in `references/authoring.md`),
  **not** `chat`. Reach for `chat` only when you are exploring by hand and do NOT want a verdict.

> **"repo-only" in this skill means "not bundled with the installed SKILL"** — not "unavailable". An
> **npm** install ships `docs/`, `README.md` and `SPEC.md` in the tarball, so try
> `node_modules/cowork-harness/docs/<name>.md` before assuming a pointer dangles. A **plugin**
> install loads a trimmed source-only cache where those pointers genuinely do dangle.

Full command set: `skill · run · chat · record · replay · verify-cassettes · rehash · prune · migrate-run-dir · lint ·
lint-skill · analyze-skill · probe-dispatch ·
verify-run · trace · inspect · diff · critique · stats · decide · gates · answer · scaffold · assertions --list · sync ·
list · boundary-check · status · vm <init|status|delete|prune> · doctor · init-redact`. Always check `cowork-harness <cmd> --help`.

**Two different `scaffold` tools — don't confuse them.** The native `cowork-harness scaffold <run-id>`
above turns an already-*recorded* run into a scenario (needs a run to exist first). The bundled
`scripts/scenario.py scaffold --name … --skill …` — see *Scaffold a valid scenario, then lint before
you push* in `references/authoring.md` — builds a scenario from flags alone, no run required. Passing that section's
flag set to the native command fails with `unknown flag: --name` (exit 2).

## Invariants — how a green run lies

Each of these has produced a green run that tested nothing. The full catalog, with the reasoning
behind each, is [`references/gotchas.md`](references/gotchas.md).

1. **`result: success` is not "the task completed".** It means the agent didn't error. Assert the
   deliverable (`file_exists` / `artifact_json` / `transcript_matches`). A `skill`-lane `PASS` only means
   no guard fired: read `skillsInvoked`, `models` and `ablated` before concluding anything from it.
2. **`replay` skips live-only keys.** Filesystem and egress keys are skipped on replay (loudly), so a
   mixed item like `{result, egress_denied}` greens on its content half. Keep one concern per `assert:`
   item, put live-only checks on a live gate, and run `cowork-harness lint`.
3. **Only scripted answers reproduce.** Scripted `answers:` + `on_unanswered: fail` is the CI channel.
   `first`, an LLM decider and `--decider-dir` all flag the run `nonDeterministic`, and `first` masks
   the gate it answers.
4. **`replay` evaluates the FROZEN scenario.** Editing `scenarios/*.yaml` changes nothing on a plain
   `replay`: re-check an `assert:` edit with `replay --assert-from <file>`, and re-record for any other key.
5. **Some keys pass on absence.** `gate_answers_delivered` passes when no gate fired — pair it with
   `gate_answer_count_min: 1`. `tool_called` proves a tool ran, not that it was attempted.
6. **An untracked skill mounts empty.** `git add` a new skill before testing it, and commit before
   recording the cassette that locks it.
7. **The tier decides what exists.** `protocol` has no sandbox and no egress, tool names differ per tier
   (`container` serves `mcp__workspace__web_fetch`, not `WebFetch`), and every tier models Cowork's
   desktop-local lane only.
8. **A WARN signal never blocks a green.** Read the verdict signals after every run
   (`prompt_asset_missing`, `undelivered_deliverables`, `model_fallback`, …).

## Short workflows

- **Author, then lock:** `scripts/scenario.py scaffold …` → `cowork-harness lint scenarios/` →
  `cowork-harness record <file.yaml> --dry-run` (free) → `record` once, with `--out` at a tracked path
  (a cassette cannot be moved) → `replay` on the PR gate.
- **Fix answers without paying:** `--keep` one run → `trace <run-dir> --view questions` → edit
  `answers:` → `verify-run <run-dir> <scenario.yaml>` → record once.
- **Debug:** the triage table in `references/debugging.md` → `inspect`, `trace --view …`,
  `verify-run`, `diff`. For a green you don't trust: `replay --explain`, then the gotchas.
- **Measure:** `--repeat N` for flakiness. `--ablate-skill` runs the control arm only; run the treatment
  arm yourself, with the model pinned and the skill committed.

## References — where the detail lives

| File | Read it for |
|---|---|
| [`references/authoring.md`](references/authoring.md) | session vs scenario, discovery, fidelity tier, the answer-channel decision tree, `web_fetch`, scaffold + lint |
| [`references/assertions-guide.md`](references/assertions-guide.md) | the two assertion axes, the goal → key map |
| [`references/run-record-replay.md`](references/run-record-replay.md) | run / `verify-run`, recording and cassette placement, real-document validation, verdict signals, background-run liveness, CI lanes |
| [`references/measurement.md`](references/measurement.md) | `--repeat`, `--ablate-skill`, measurement hygiene |
| [`references/debugging.md`](references/debugging.md) | triage, `result.json` fields and `trace` views, `chat` |
| [`references/gotchas.md`](references/gotchas.md) | the full "✓ passed ≠ correct" landmine catalog |
| [`references/task-recipes.md`](references/task-recipes.md) | end-to-end recipes: evolve `assert:`, audit tier drift, redaction, budgets, answer quality |
| [`references/assertion-catalog.md`](references/assertion-catalog.md) | every `assert:` key's semantics, the verdict-signal table |
| [`references/scenario-schema.md`](references/scenario-schema.md) | every YAML field, which keys survive `replay`, the `web_fetch` model |
| [`references/fidelity-and-answers.md`](references/fidelity-and-answers.md) | tier semantics, answer paths, the determinism contract |
| [`references/ci-recipe.md`](references/ci-recipe.md) | the GitHub Action, replay-vs-live lanes, the four-stage pipeline |
| [`references/critique.md`](references/critique.md) | `critique` report and evidence-package shapes |
| `scripts/scenario.py` | `scaffold`, `lint`, `lint-skill`, `resolve-agent-types <plugin-dir>` |
