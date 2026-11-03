/**
 * Which earlier round a judge, critique or retry reads.
 *
 * A change can hold several councils at once, one an area of a large
 * change, so "the latest" is only the answer when nobody named one.
 * On 3 November a judge asked of the second of two councils on one
 * change consolidated the first again, for $10.69, because the judge
 * never looked at the id it was given.
 */

import type {
	AskRun,
	ChangeRef,
	RunStore,
} from "../../lib/core/review/index.ts";

/** The kinds of round another round reads. */
export type ReadRound = "council" | "judge";

/** The round to read, none at all, or why the one named can't be. */
export type RoundToRead =
	| { run: AskRun }
	| { none: true }
	| { refusal: string };

/**
 * The round of kind `round` to read on `change`: the one `id` names,
 * or the latest finished one when `id` is left out.
 *
 * A named round that is unknown, of another kind, still open or given
 * up on is refused, naming the finished rounds that could be read, so
 * the caller is never handed a round other than the one it asked for.
 */
export async function roundToRead(
	store: RunStore,
	change: ChangeRef,
	round: ReadRound,
	id?: string,
): Promise<RoundToRead> {
	if (id === undefined) {
		const latest = await store.latest(change, round);
		return latest === undefined ? { none: true } : { run: latest };
	}

	const held = await store.byId(change, id);
	if (held !== undefined && held.round === round && finished(held)) {
		return { run: held };
	}

	const choices = (await store.list(change)).filter(
		(r) => r.round === round && finished(r),
	);
	const could =
		choices.length === 0
			? `No ${round} has finished on ${change.label}.`
			: `Finished: ${choices.map((r) => r.id).join(", ")}.`;
	if (held === undefined) {
		return {
			refusal: `No round "${id}" is held against ${change.label}. ${could}`,
		};
	}
	if (held.round !== round) {
		return { refusal: `${id} is a ${held.round}, not a ${round}. ${could}` };
	}
	return {
		refusal: `${id} ${held.open === true ? "has not been collected" : "was given up on"}, so it has nothing finished to read. ${could}`,
	};
}

/** Whether a round settled with answers, rather than open or given up. */
function finished(run: AskRun): boolean {
	return run.open !== true && run.closed !== true;
}
