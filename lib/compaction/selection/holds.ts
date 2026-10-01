/**
 * Whether a paragraph still holds: asked of the paragraphs a compaction
 * would quote, against what was said after them, so an instruction the
 * user withdrew or a question since answered is not brought back as if
 * it stood.
 *
 * The context is what the user said later, since that is where a
 * withdrawal comes from, and the end of the conversation, since that
 * is where the work stands. Candidates go in batches small enough that
 * each still gets a careful reading.
 */

import type {
	ClassifierBoolQuestion,
	ClassifierContext,
	Usage,
} from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Candidate } from "./candidates.ts";
import { aboutParagraph, classifierContext, type Passage } from "./classify.ts";
import { KIND_DEFINITIONS } from "./kinds.ts";
import { recentContext } from "./tagging.ts";
import { estimatedTokens, type SelectionUnit } from "./units.ts";

/** The custom entry type a batch of judgements is recorded under. */
export const SELECTION_HOLDS_ENTRY = "compaction-selection-holds";

/** One batch of judgements, as recorded. */
export interface SelectionHolds {
	/** For each candidate's hash, the probability that it still holds. */
	readonly holds: Readonly<Record<string, number>>;
	readonly model?: string;
	readonly usage?: Usage;
	/** How long the classifier took to answer, in milliseconds. */
	readonly ms?: number;
	/** Why the batch failed, when it did. */
	readonly failed?: string;
}

/**
 * Every judgement recorded since the last compaction, by candidate
 * hash, the latest winning. One from before it was made against a
 * conversation that has moved on, so it is asked again.
 */
export function readHolds(
	branch: readonly SessionEntry[],
): Map<string, number> {
	let start = 0;
	branch.forEach((entry, at) => {
		if (entry.type === "compaction") start = at + 1;
	});
	const holds = new Map<string, number>();
	for (const entry of branch.slice(start)) {
		if (entry.type !== "custom" || entry.customType !== SELECTION_HOLDS_ENTRY)
			continue;
		const data = entry.data;
		if (typeof data !== "object" || data === null) continue;
		const recorded = (data as Record<string, unknown>).holds;
		if (typeof recorded !== "object" || recorded === null) continue;
		for (const [hash, value] of Object.entries(recorded)) {
			if (typeof value === "number") holds.set(hash, value);
		}
	}
	return holds;
}

/** How many candidates one request asks about. */
export const HOLDS_BATCH = 12;

/** About how much of what the user said later goes with a batch. */
const LATER_USER_TOKENS = 1500;

/** About how much of the end of the conversation goes with a batch. */
const RECENT_TOKENS = 1500;

/** The requests that ask whether each candidate still holds. */
export function holdsRequests(
	candidates: readonly Candidate[],
	/** Every paragraph on the branch, in order, for the later context. */
	branchUnits: readonly SelectionUnit[],
	batch = HOLDS_BATCH,
): ClassifierContext[] {
	const requests: ClassifierContext[] = [];
	const position = new Map(branchUnits.map((unit, at) => [unit.hash, at]));
	const recent = recentContext(branchUnits, RECENT_TOKENS);
	const recentHashes = new Set(
		branchUnits.slice(branchUnits.length - recent.length).map((u) => u.hash),
	);
	for (let start = 0; start < candidates.length; start += batch) {
		const chunk = candidates.slice(start, start + batch);
		const earliest = Math.min(
			...chunk.map((c) => position.get(c.unit.hash) ?? branchUnits.length),
		);
		const laterUser = latestFitting(
			branchUnits
				.slice(earliest + 1)
				.filter(
					(unit) => unit.speaker === "user" && !recentHashes.has(unit.hash),
				),
			LATER_USER_TOKENS,
		);
		const questions: Record<string, ClassifierBoolQuestion> = {};
		chunk.forEach((candidate, at) => {
			questions[questionId(at)] = aboutParagraph(
				unitId(at),
				KIND_DEFINITIONS[candidate.kind].holds,
			);
		});
		requests.push(
			classifierContext(
				[...laterUser, ...recent],
				chunk.map((candidate, at) => ({
					id: unitId(at),
					text: candidate.unit.text,
					speaker: candidate.unit.speaker,
				})),
				questions,
			),
		);
	}
	return requests;
}

/**
 * For each candidate in a request, by its hash, the probability that it
 * still holds. A candidate the reply skipped is left out, so it stays
 * unjudged rather than judged either way.
 */
export function holdsFrom(
	chunk: readonly Candidate[],
	answers: Readonly<Record<string, number>>,
): Map<string, number> {
	const verdicts = new Map<string, number>();
	chunk.forEach((candidate, at) => {
		const answer = answers[questionId(at)];
		if (answer !== undefined) verdicts.set(candidate.unit.hash, answer);
	});
	return verdicts;
}

function latestFitting(
	units: readonly SelectionUnit[],
	tokens: number,
): Passage[] {
	const kept: Passage[] = [];
	let spent = 0;
	for (let at = units.length - 1; at >= 0; at--) {
		const unit = units[at];
		if (!unit) continue;
		const cost = estimatedTokens(unit.text);
		if (spent + cost > tokens) break;
		spent += cost;
		kept.unshift({ id: `l${at}`, text: unit.text, speaker: unit.speaker });
	}
	return kept;
}

function unitId(at: number): string {
	return `u${at}`;
}

function questionId(at: number): string {
	return `${unitId(at)}.holds`;
}
