import type { TimelineEvent } from "../agent/timeline.js";

/** One tool's entry in `RunResult.toolDurations`. `calls`/`totalMs`/`maxMs` are over PAIRED calls only
 *  (a `tool_use` whose `tool_result` arrived in this timeline); both are 0 when `calls` is 0. `unpaired`
 *  counts this tool's calls that carried an id but never paired, so they have no duration. */
export interface ToolDurationEntry {
  calls: number;
  totalMs: number;
  maxMs: number;
  unpaired: number;
}

/** What `toolDurations` measures. One value today; the field exists so a consumer never has to infer it. */
export type ToolDurationsBasis = "wall_gap";

/**
 * Pairs each `tool_use` with its `tool_result` by `toolUseId` and aggregates the wall gap between them
 * per tool name.
 *
 * What the number is (the basis, `"wall_gap"`): harness-observed wall time from the moment the
 * `tool_use` was seen on the stream to the moment its `tool_result` was seen. It includes model and
 * transport latency and any permission/decider round-trip, and an `Agent`/`Task` entry spans its whole
 * sub-agent run. It is not isolated execution time: the SDK stream carries no runtime-side exec
 * start/end stamp. On replay these are the record-time timestamps, frozen in the cassette.
 *
 * Scope: every call in the timeline — main agent and sub-agents alike. `trace --view tool-durations
 * --scope` narrows it.
 *
 * Unpaired: a `tool_use` WITH an id and no matching `tool_result` (e.g. the run ended mid-call) is
 * counted in `unpaired`, so a tool is listed even when none of its calls paired. A `tool_use` with NO id
 * is not counted anywhere: on a real stream it is the synthetic MCP round-trip echo of a call that
 * already arrived with an id (session.ts marks it `synthetic`; the timeline keeps no flag), and counting
 * it would report every paired `mcp__*` call as unpaired too. A `tool_result` with no matching
 * `tool_use` pairs nothing and is ignored.
 */
export function foldToolDurations(timeline: TimelineEvent[]): Record<string, ToolDurationEntry> {
  const out: Record<string, ToolDurationEntry> = {};
  for (const c of pairToolCalls(timeline)) {
    const bucket = (out[c.name] ??= { calls: 0, totalMs: 0, maxMs: 0, unpaired: 0 });
    if (c.endTs === undefined) {
      bucket.unpaired += 1;
      continue;
    }
    const callMs = c.endTs - c.startTs;
    bucket.calls += 1;
    bucket.totalMs += callMs;
    bucket.maxMs = Math.max(bucket.maxMs, callMs);
  }
  return out;
}

/** One `tool_use` that carried an id, with its paired `tool_result` time when one arrived. In stream
 *  order of the `tool_use`. The single pairing rule behind both `foldToolDurations` and the per-call
 *  trace view, so the aggregate and the rows can never disagree. */
export interface PairedToolCall {
  toolUseId: string;
  name: string;
  parentToolUseId?: string;
  startTs: number;
  endTs?: number;
}

export function pairToolCalls(timeline: TimelineEvent[]): PairedToolCall[] {
  const calls: PairedToolCall[] = [];
  const pending = new Map<string, PairedToolCall>();
  for (const ev of timeline) {
    if (ev.type === "tool_use" && ev.toolUseId) {
      const c: PairedToolCall = { toolUseId: ev.toolUseId, name: ev.name, parentToolUseId: ev.parentToolUseId, startTs: ev.ts };
      calls.push(c);
      pending.set(ev.toolUseId, c);
    } else if (ev.type === "tool_result" && ev.toolUseId) {
      const c = pending.get(ev.toolUseId);
      if (!c) continue;
      pending.delete(ev.toolUseId);
      c.endTs = ev.ts;
    }
  }
  return calls;
}

/** `toolDurations` and its basis, derived together so a RunResult can never carry one without the
 *  other. Every RunResult assembly site spreads this. `undefined` in = no usable timeline = neither. */
export function toolDurationFields(timeline: TimelineEvent[] | undefined): {
  toolDurations: Record<string, ToolDurationEntry> | undefined;
  toolDurationsBasis: ToolDurationsBasis | undefined;
} {
  if (!timeline) return { toolDurations: undefined, toolDurationsBasis: undefined };
  return { toolDurations: foldToolDurations(timeline), toolDurationsBasis: "wall_gap" };
}

export interface SkillActivityEntry {
  skillId: string;
  invocationSeq: number;
  toolCounts: Record<string, number>;
  toolCallCount: number;
  dispatchCount: number;
  durationMs?: number;
}

/**
 * Groups CONSECUTIVE (in seq order) timeline entries sharing the same `skillScope` into one window —
 * NOT a merge-by-value across the whole timeline, since the same skill invoked twice with something
 * else in between is two separate invocations (windows are sequential, never re-opened).
 * `invocationSeq` is the seq of the window's first entry (for a real skill window that IS the Skill
 * tool_use itself; for "(root)", it's simply the first entry's seq — there's no literal invocation).
 * `durationMs` is the window's last-entry-ts minus first-entry-ts; `undefined` is never produced here
 * (every entry always has a `ts`) but the field stays optional to match `RunResult.skillActivity`'s
 * declared shape for parity with `toolDurations`'s convention.
 * A window's `toolCounts`/`toolCallCount` include tool calls made by any sub-agent dispatched during
 * that window (parented `tool_use` events inherit the window's `skillScope`), not just literal
 * top-level calls — matching `foldToolDurations`'s same subagent-inclusive scope above.
 * A `tool_use` with no `toolUseId` is a synthetic MCP round-trip echo (the real call already arrived
 * as an assistant `tool_use` block with a `toolUseId`) and is excluded, mirroring `foldToolDurations`'s
 * de-facto exclusion (it only pairs entries that have a `toolUseId`) and `run.ts`'s top-level
 * `toolCounts` (`else if (!ev.synthetic)`) — otherwise a bogus `mcp__*` key could appear here that no
 * other RunResult field shows, and `skill_tool_used` could false-pass against the echo alone.
 */
export function foldSkillActivity(timeline: TimelineEvent[]): SkillActivityEntry[] {
  const windows: (SkillActivityEntry & { startTs: number; endTs: number })[] = [];
  let current: (SkillActivityEntry & { startTs: number; endTs: number }) | undefined;
  for (const ev of timeline) {
    if (ev.type !== "tool_use" && ev.type !== "subagent_dispatch") continue;
    if (ev.type === "tool_use" && !ev.toolUseId) continue; // synthetic MCP echo — no toolUseId, already counted via the real tool_use block
    const skillId = ev.skillScope ?? "(root)";
    if (!current || current.skillId !== skillId) {
      current = { skillId, invocationSeq: ev.seq, toolCounts: {}, toolCallCount: 0, dispatchCount: 0, startTs: ev.ts, endTs: ev.ts };
      windows.push(current);
    }
    current.endTs = ev.ts;
    if (ev.type === "tool_use") {
      current.toolCounts[ev.name] = (current.toolCounts[ev.name] ?? 0) + 1;
      current.toolCallCount++;
    } else {
      current.dispatchCount++;
    }
  }
  return windows.map(({ startTs, endTs, ...rest }) => ({ ...rest, durationMs: endTs - startTs }));
}

/** Denormalizes each subagent's attributed skill window from the matching TimelineEvent —
 *  looked up by toolUseId, mirroring the existing tool-result/output pairing pattern in run.ts. Pure,
 *  non-mutating (returns new objects) so callers can use it directly in an assembleRunResult literal. */
export function attributeSubagentSkills<T extends { toolUseId: string }>(
  subagents: T[],
  timeline: TimelineEvent[],
): (T & { attributedSkillId?: string })[] {
  const byToolUseId = new Map<string, string | undefined>();
  for (const ev of timeline) if (ev.type === "subagent_dispatch") byToolUseId.set(ev.toolUseId, ev.skillScope);
  return subagents.map((sa) => ({ ...sa, attributedSkillId: byToolUseId.get(sa.toolUseId) }));
}
