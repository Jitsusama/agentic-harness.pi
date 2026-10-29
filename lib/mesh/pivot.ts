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
	present: readonly Pick<
		Presence,
		"addresses" | "orchestratedBy" | "orchestrates"
	>[],
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
		const ask = outside
			.map((group) => whoToAsk(group, present))
			.filter((line): line is string => line !== undefined);
		return {
			refused: `a pivot goes only to this orchestration, ${own}, or the sessions in it, and ${outside.join(", ")} ${outside.length === 1 ? "is" : "are"} outside it${ask.length > 0 ? `. ${ask.join(". ")}` : ""}`,
		};
	}
	return { to: named };
}

/**
 * Who to ask instead about a session in another orchestration: its
 * orchestrator, since only Joel or a session's own orchestrator turns
 * it, and orchestrators coordinate as equals, by question. Nothing when
 * no present peer says whose it is.
 */
function whoToAsk(
	group: string,
	present: readonly Pick<
		Presence,
		"addresses" | "orchestratedBy" | "orchestrates"
	>[],
): string | undefined {
	const target = present.find((one) =>
		one.addresses.map(homeOf).includes(group),
	);
	if (!target) return undefined;
	if (target.orchestrates !== undefined) {
		return `${group} is an orchestrator; ask it with a question`;
	}
	if (target.orchestratedBy === undefined) return undefined;
	const orchestrator = present.find(
		(one) => one.orchestrates === target.orchestratedBy,
	);
	const by = orchestrator?.addresses[0];
	return by
		? `${group} is in ${by}'s orchestration; send it to ${by} as a question`
		: `${group} is in ${target.orchestratedBy}'s orchestration, whose orchestrator isn't on the mesh now; send it to ${orchestrationGroup(target.orchestratedBy)} as a question`;
}
