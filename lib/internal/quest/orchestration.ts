/**
 * Orchestration: which quest's session a quest answers to.
 *
 * A quest marked `orchestrator: true` is played by the live session that
 * has it loaded, and it orchestrates every quest below it, up to the
 * next quest below that is marked too. So a quest's orchestrator is
 * found by walking up `parent` to the nearest marked quest, with no
 * address wired anywhere; a quest an orchestrator takes on from outside
 * its tree names it with `orchestratedBy`, which wins over the walk. An
 * orchestrator nested under another answers to the one above it, and
 * heads its own.
 *
 * Only quests are read here. The mesh hears of the result through
 * presence and never reads a quest to route by it.
 */

import type { QuestFrontMatter } from "../../quest/types.ts";

/** Where a quest sits in the orchestrations above it. */
export interface Orchestration {
	/** The quest whose orchestrator it answers to, when one is above it. */
	readonly by?: string;
	/** The quest itself, when it orchestrates. */
	readonly heads?: string;
}

/** How far up a quest's parents are followed, against a loop. */
const MOST_PARENTS = 8;

/**
 * Whether a quest orchestrates. Read from `_extra` too, since a README
 * last written by a parser that does not know the field keeps it there.
 */
export function orchestrates(fm: QuestFrontMatter): boolean {
	return fm.orchestrator === true || fm._extra?.orchestrator === true;
}

/** The quest a README names as its orchestrator, past the walk. */
export function namedOrchestrator(fm: QuestFrontMatter): string | undefined {
	const named = fm.orchestratedBy ?? fm._extra?.orchestratedBy;
	return typeof named === "string" && named.trim() !== ""
		? named.trim()
		: undefined;
}

/**
 * Where a quest sits: the orchestrator above it and whether it heads
 * one itself, given a way to read any quest's front matter.
 */
export function orchestrationOf(
	quest: string,
	read: (quest: string) => QuestFrontMatter | undefined,
): Orchestration {
	const own = read(quest);
	if (!own) return {};
	const by = orchestratorAbove(quest, own, read);
	return {
		...(by ? { by } : {}),
		...(orchestrates(own) ? { heads: quest } : {}),
	};
}

/** The nearest orchestrating quest above this one, or the one it names. */
function orchestratorAbove(
	quest: string,
	own: QuestFrontMatter,
	read: (quest: string) => QuestFrontMatter | undefined,
): string | undefined {
	const seen = new Set([quest]);
	let at = own;
	while (seen.size <= MOST_PARENTS) {
		const named = namedOrchestrator(at);
		if (named && !seen.has(named)) return named;
		const parent = at.parent;
		if (!parent || seen.has(parent)) return undefined;
		const above = read(parent);
		if (!above) return undefined;
		if (orchestrates(above)) return parent;
		seen.add(parent);
		at = above;
	}
	return undefined;
}
