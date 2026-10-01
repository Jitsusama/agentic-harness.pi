/**
 * Choosing which candidates a compaction quotes, within a budget.
 *
 * Standing instructions and corrections go first, most recent first,
 * since losing one is how a session repeats a mistake it was told
 * about. What budget is left is shared: the other kinds take turns,
 * most durable first, each offering its most recent candidate, so one
 * busy kind cannot crowd out the rest. A candidate judged no longer to
 * hold is not quoted; one never judged is, since the check is a
 * refinement and not a gate.
 */

import type { Candidate } from "./candidates.ts";
import { FIRST_KINDS, SELECTION_KINDS, type SelectionKind } from "./kinds.ts";
import { estimatedTokens } from "./units.ts";

/** Below this probability a candidate is taken to no longer hold. */
export const HOLDS_THRESHOLD = 0.5;

/** The candidates worth asking about or quoting, best first, within a budget. */
export function selectExcerpts(
	candidates: readonly Candidate[],
	budgetTokens: number,
	holds: ReadonlyMap<string, number> = new Map(),
): Candidate[] {
	const standing = candidates.filter(
		(c) => (holds.get(c.unit.hash) ?? 1) >= HOLDS_THRESHOLD,
	);
	const newestFirst = [...standing].sort((a, b) => b.order - a.order);
	const chosen: Candidate[] = [];
	let spent = 0;
	const take = (candidate: Candidate) => {
		const cost = estimatedTokens(candidate.unit.text);
		if (spent + cost > budgetTokens) return false;
		spent += cost;
		chosen.push(candidate);
		return true;
	};

	for (const candidate of newestFirst) {
		if (FIRST_KINDS.has(candidate.kind)) take(candidate);
	}
	const queues = new Map<SelectionKind, Candidate[]>();
	for (const kind of SELECTION_KINDS) {
		if (FIRST_KINDS.has(kind)) continue;
		queues.set(
			kind,
			newestFirst.filter((c) => c.kind === kind),
		);
	}
	// Each round offers every kind's next candidate; a kind whose next
	// one does not fit is passed over for that one, not stopped.
	while ([...queues.values()].some((queue) => queue.length > 0)) {
		for (const queue of queues.values()) {
			const next = queue.shift();
			if (next) take(next);
		}
	}
	return chosen;
}
