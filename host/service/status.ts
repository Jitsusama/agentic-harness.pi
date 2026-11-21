/**
 * What a host says of itself in words, as systemd's status and the
 * journal show it: the step its start is in, how long each phase of a
 * resume took, what it holds once ready, and what it parks as it stops.
 * run.ts says these at the moments they belong to; the words change for
 * the people reading them, apart from when the host says them.
 */

import type { ResumePhase } from "./backend.ts";
import type { ServingHost, StartStep } from "./serve.ts";

const MS_PER_SECOND = 1000;

/** What a ready host holds, counted for its status. */
export interface ReadyCount {
	/** Conversations it runs, built and awake. */
	readonly loaded: number;
	/** Conversations it runs parked, building nothing until asked for. */
	readonly parked: number;
	/** Holds its start dropped, since their session files were gone. */
	readonly dropped: number;
	/** Holds it keeps but could not resume. */
	readonly unresumed: number;
	/** Conversations it holds that run in processes of their own. */
	readonly children?: number;
}

/**
 * What a serving host holds, counted for its ready status. A resume
 * that fails once it has registered leaves its conversation parked in
 * the host's list, so one of those counts as not resumed, never parked.
 */
export function readyCount(
	serving: Pick<
		ServingHost,
		| "held"
		| "unresumed"
		| "dropped"
		| "resting"
		| "stillUnresumed"
		| "inChildren"
	>,
): ReadyCount {
	const held = serving.held();
	const failed = new Set(serving.unresumed.map(({ sessionId }) => sessionId));
	const parkedFailed = held.filter(
		({ id, state }) => state === "parked" && failed.has(id),
	).length;
	const asleep =
		held.filter(({ state }) => state === "parked").length - parkedFailed;
	return {
		loaded: held.length - asleep - parkedFailed,
		parked: asleep + serving.resting(),
		dropped: serving.dropped.length,
		unresumed: serving.stillUnresumed(),
		children: serving.inChildren?.() ?? 0,
	};
}

/**
 * A ready host's status in words, as systemd's status and the journal
 * show it: how many it loaded, left parked and dropped, and any held but
 * not resumed.
 */
export function readyStatus(count: ReadyCount): string {
	const { loaded, parked, dropped, unresumed, children = 0 } = count;
	const apart = children > 0 ? `, ${children} in processes of their own` : "";
	const held = unresumed > 0 ? `, ${unresumed} held but not resumed` : "";
	return `ready: loaded ${loaded}, parked ${parked}${apart}, dropped ${dropped}${held}`;
}

/**
 * The holds a start dropped, named for the journal's ready line; nothing
 * when it dropped none. systemd's status keeps only the count, since a
 * start may drop dozens.
 */
export function droppedNames(dropped: readonly string[]): string {
	if (dropped.length === 0) return "";
	return ` (dropped, their session files gone: ${dropped.join(", ")})`;
}

/** A stopping host's status in words, while it parks what it runs. */
export function stoppingStatus(parking: number): string {
	return `stopping, parking ${conversations(parking)}`;
}

function conversations(count: number): string {
	if (count === 0) return "no conversations";
	return `${count} conversation${count === 1 ? "" : "s"}`;
}

/** When one phase of a resume ended. */
export interface PhaseEnd {
	readonly phase: ResumePhase;
	readonly at: number;
}

/**
 * How long each phase of a resume begun at `began` took, in words, and
 * what followed the last until `ended`; nothing when none was marked.
 */
export function phaseTimes(
	began: number,
	phases: readonly PhaseEnd[],
	ended: number,
): string {
	if (phases.length === 0) return "";
	let from = began;
	const parts = phases.map(({ phase, at }) => {
		const part = `${phase} ${((at - from) / MS_PER_SECOND).toFixed(1)} s`;
		from = at;
		return part;
	});
	parts.push(`rest ${((ended - from) / MS_PER_SECOND).toFixed(1)} s`);
	return ` (${parts.join(", ")})`;
}

/** A start step in words, as the journal and systemd's status show it. */
export function describeStep(step: StartStep): string {
	if (step.step === "roster")
		return `waiting on the last host, pid ${step.holder}, to let go of the roster`;
	return step.step === "engine"
		? "building the engine"
		: `resuming ${step.number} of ${step.of}: ${step.sessionId}`;
}
