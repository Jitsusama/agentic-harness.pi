/**
 * The order walks of World's objects wait in among themselves. It
 * changes with what World's push gate and its callers need first,
 * rather than with the rules of who gets a turn (next-turn.ts).
 */

import type { Job } from "./job.ts";
import { pushClassOfJob } from "./push-class.ts";

/** Where a push, a fetch of main or a branch's own walk stands in its class. */
const LEADS = 0;

/** Where any other walk stands in its class, behind those that lead. */
const FOLLOWS = 1;

/**
 * The line, with its walks of World's objects reordered among the
 * places walks hold: by the class their caller gave World's push gate,
 * 0 first (see push-class.ts), and within a class pushes, fetches of
 * main and a branch's own rebases, cherry-picks, reverts, merges and
 * sparse-checkouts first, then the rest, as fetches of other people's
 * branches, each group in the order it had.
 * Other work keeps its place. On 5 November a push of Joel's waited 61
 * minutes behind review fetches of single branches (80ECO2), and at
 * 17:24 on 27 November a class-0 fetch waited 2052 s behind class-1
 * walks.
 */
export function walksLeadingFirst(line: Job[]): Job[] {
	const places = line.flatMap((job, at) =>
		job.kind === "world-walk" ? [at] : [],
	);
	const leads = (job: Job) =>
		job.walk !== undefined && job.walk !== "other" ? LEADS : FOLLOWS;
	// A sort keeps the order it had among equals.
	const ordered = line
		.filter((job) => job.kind === "world-walk")
		.sort(
			(one, other) =>
				pushClassOfJob(one) - pushClassOfJob(other) ||
				leads(one) - leads(other),
		);
	const reordered = [...line];
	for (const [index, job] of ordered.entries()) {
		const at = places[index];
		if (at !== undefined) reordered[at] = job;
	}
	return reordered;
}
