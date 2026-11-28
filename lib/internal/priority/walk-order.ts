/**
 * The order walks of World's objects wait in among themselves. It
 * changes with what World's push gate and its callers need first,
 * rather than with the rules of who gets a turn (next-turn.ts).
 */

import type { Job } from "./job.ts";
import { type PushClass, pushClassOfJob } from "./push-class.ts";

/** Where a push, a fetch of main or a branch's own walk stands in its class. */
const LEADS = 0;

/** Where any other walk stands in its class, behind those that lead. */
const FOLLOWS = 1;

/** The class a walk waiting past {@link CLASS_HOLDS_FOR_MS} waits as. */
const AGED_CLASS: PushClass = 0;

/**
 * How long a walk waits by the class its caller gave World's push gate
 * before it waits as class 0 whatever it was given, so a stream of
 * sooner classes can't hold it with no end, as class-1 fetches of other
 * branches could hold a push given no class. None of the queue's bounds
 * fits: each says how long something runs or is held, not how long a
 * class may be passed. Fetches of main from 4 to 5 November ran a median
 * 108 s, and nine in ten under 11 minutes, so 20 minutes leaves the
 * sooner walks already waiting room to take their turns, and is a third
 * of the 61 minutes a push of Joel's waited on 5 November.
 */
export const CLASS_HOLDS_FOR_MS = 20 * 60_000;

/**
 * The line, with its walks of World's objects reordered among the
 * places walks hold: by the class their caller gave World's push gate,
 * 0 first (see push-class.ts), or as class 0 once one has waited past
 * {@link CLASS_HOLDS_FOR_MS} at `now`, and within a class pushes, fetches of
 * main and a branch's own rebases, cherry-picks, reverts, merges and
 * sparse-checkouts first, then the rest, as fetches of other people's
 * branches, each group in the order it had.
 * Other work keeps its order. A walk takes the place the next walk
 * still to place held, or its own if that was sooner, so one put back
 * never lands behind other work that was behind it. On 5 November a push of Joel's waited 61
 * minutes behind review fetches of single branches (80ECO2), and at
 * 17:24 on 27 November a class-0 fetch waited 2052 s behind class-1
 * walks.
 */
export function walksLeadingFirst(line: readonly Job[], now: number): Job[] {
	const placed = line.map((job, at) => ({ job, at }));
	const isWalk = ({ job }: { job: Job }) => job.kind === "world-walk";
	const classOf = (job: Job) =>
		now - Date.parse(job.since) > CLASS_HOLDS_FOR_MS
			? AGED_CLASS
			: pushClassOfJob(job);
	const leads = (job: Job) =>
		job.walk !== undefined && job.walk !== "other" ? LEADS : FOLLOWS;
	// A sort keeps the order it had among equals.
	const walks = placed
		.filter(isWalk)
		.sort(
			(one, other) =>
				classOf(one.job) - classOf(other.job) ||
				leads(one.job) - leads(other.job),
		);
	// The places walks held, soonest first: the n-th walk placed takes the
	// n-th of them unless its own was sooner.
	const places = walks.map(({ at }) => at).sort((one, other) => one - other);
	const others = placed.filter((one) => !isWalk(one));
	const reordered: Job[] = [];
	let walk = 0;
	let other = 0;
	for (;;) {
		const nextWalk = walks[walk];
		const nextOther = others[other];
		if (nextWalk === undefined || nextOther === undefined) break;
		const due = Math.min(places[walk] ?? nextWalk.at, nextWalk.at);
		if (due < nextOther.at) {
			reordered.push(nextWalk.job);
			walk += 1;
		} else {
			reordered.push(nextOther.job);
			other += 1;
		}
	}
	for (const { job } of [...walks.slice(walk), ...others.slice(other)]) {
		reordered.push(job);
	}
	return reordered;
}
