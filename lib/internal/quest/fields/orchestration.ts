/**
 * Orchestration: which quest's session a quest answers to.
 *
 * A quest marked `orchestrator: true` is played by the live session that
 * has it loaded, and it orchestrates every quest below it, up to the
 * next quest below that is marked too. So a quest's orchestrator is
 * found by walking up `parent` to the nearest marked quest, with no
 * address wired anywhere; a quest an orchestrator takes on from outside
 * its tree names it with `orchestratedBy`, which wins over the walk
 * while the quest it names is marked. An
 * orchestrator nested under another answers to the one above it, and
 * heads its own.
 *
 * Only quests are read here. The mesh hears of the result through
 * presence and never reads a quest to route by it.
 */

import type { QuestFrontMatter } from "../../../quest/types.ts";

/** Where a quest sits in the orchestrations above it. */
export interface Orchestration {
	/** The quest whose orchestrator it answers to, when one is above it. */
	readonly by?: string;
	/** The quest itself, when it orchestrates. */
	readonly heads?: string;
	/**
	 * The nearest quest above it that is the person's steward, when one
	 * is: who carries what needs the person, apart from who orders work.
	 */
	readonly steward?: string;
	/**
	 * The quest itself, when it is the person's steward: its session ends
	 * the person's path, talking with the person rather than through
	 * anyone, so no steward above it and no orchestrator carries it.
	 */
	readonly stewards?: string;
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

/**
 * Whether a quest is the person's steward. Only the parsed field counts:
 * a steward written by hand that can't be read is kept in `_extra` for
 * config to name, and makes no steward.
 */
export function stewards(fm: QuestFrontMatter): boolean {
	return fm.steward === true;
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
	const self = stewards(own);
	const steward = self ? undefined : stewardAbove(quest, own, read);
	return {
		...(by ? { by } : {}),
		...(orchestrates(own) ? { heads: quest } : {}),
		...(steward ? { steward } : {}),
		...(self ? { stewards: quest } : {}),
	};
}

/**
 * The nearest quest above this one, up `parent`, that is the person's
 * steward. Never the quest itself, and never asked of a steward: its
 * own session talks with the person rather than through anyone, so
 * stewards nested do not chain (see `orchestrationOf`).
 */
function stewardAbove(
	quest: string,
	own: QuestFrontMatter,
	read: (quest: string) => QuestFrontMatter | undefined,
): string | undefined {
	const seen = new Set([quest]);
	let at = own;
	while (seen.size <= MOST_PARENTS) {
		const parent = at.parent;
		if (!parent || seen.has(parent)) return undefined;
		const above = read(parent);
		if (!above) return undefined;
		if (stewards(above)) return parent;
		seen.add(parent);
		at = above;
	}
	return undefined;
}

/**
 * The quest whose workspace a session of this quest opens its window
 * on: the topmost orchestrator above it, through every nested one, else
 * the quest itself. Joel steers a session through that orchestrator, so
 * its window belongs beside it; a workspace is told by this quest's
 * address as a name, since positions and ids change with every boot
 * (13 November, when reopened windows landed on the workspace he was
 * on). Undefined for a quest that can't be read.
 */
export function windowWorkspaceOf(
	quest: string,
	read: (quest: string) => QuestFrontMatter | undefined,
): string | undefined {
	const own = read(quest);
	if (!own) return undefined;
	const seen = new Set([quest]);
	let top = quest;
	let at = own;
	while (seen.size <= MOST_PARENTS) {
		const above = orchestratorAbove(top, at, read);
		const next = above && !seen.has(above) ? read(above) : undefined;
		if (!above || !next) return top;
		seen.add(above);
		top = above;
		at = next;
	}
	return top;
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
		// A named quest counts only while it orchestrates, so a stale name
		// left after the mark was cleared does not route to a plain quest.
		const named = namedOrchestrator(at);
		const namedQuest = named && !seen.has(named) ? read(named) : undefined;
		if (named && namedQuest && orchestrates(namedQuest)) return named;
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
