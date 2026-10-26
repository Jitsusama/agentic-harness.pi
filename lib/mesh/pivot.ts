/**
 * Who may pivot whom.
 *
 * A pivot changes what a session is doing, so it keeps its authority
 * only on the way down: the session playing an orchestrator's role sends
 * one to its own orchestration, or to sessions whose quests it
 * orchestrates, and nobody else sends one at all. The orchestrator's
 * mark is read as the pivot is sent, so one whose orchestration has
 * since been undone is refused rather than delivered.
 */

import { homeOf } from "./group.ts";
import type { Presence } from "./presence.ts";
import { orchestrationGroup } from "./scope.ts";

/** Where a pivot goes, or why it may not be sent. */
export type PivotTargets =
	| { readonly to: readonly string[] }
	| { readonly refused: string };

/**
 * Where a pivot from the orchestrator heading `orchestrates` goes, given
 * the groups it named: its orchestration when it named none, what it
 * named when all of it is inside, and a refusal otherwise.
 */
export function pivotTargets(
	orchestrates: string | undefined,
	named: readonly string[],
	present: readonly Pick<Presence, "addresses" | "orchestratedBy">[],
): PivotTargets {
	if (orchestrates === undefined) {
		return {
			refused:
				"only an orchestrator sends a pivot, and this session plays no orchestrator's role. Send what should change to the orchestrator as a question",
		};
	}
	const own = orchestrationGroup(orchestrates);
	if (named.length === 0) return { to: [own] };
	const under = new Set(
		present
			.filter((one) => one.orchestratedBy === orchestrates)
			.flatMap((one) => one.addresses.map(homeOf)),
	);
	const outside = named.filter((group) => group !== own && !under.has(group));
	if (outside.length > 0) {
		return {
			refused: `a pivot goes only to this orchestration, ${own}, or the sessions in it, and ${outside.join(", ")} ${outside.length === 1 ? "is" : "are"} outside it`,
		};
	}
	return { to: named };
}
