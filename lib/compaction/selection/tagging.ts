/**
 * Tagging one message: asking, of each of its paragraphs, which kinds
 * it is, with the paragraphs before it as context so a reply like "yes,
 * do that" can be read.
 */

import {
	CLASSIFICATION_CONTRACT,
	type ClassificationAnswers,
	type ClassificationQuestion,
	type ClassificationRequest,
	type ClassificationUnit,
} from "../../classifier/index.ts";
import { KIND_DEFINITIONS, kindsFor, type SelectionKind } from "./kinds.ts";
import type { UnitTags } from "./tags.ts";
import { estimatedTokens, type SelectionUnit } from "./units.ts";

/** About how much of what came before a message is sent with it. */
export const TAGGING_CONTEXT_TOKENS = 1500;

/** At or above this probability a paragraph is taken to be the kind. */
export const TAG_THRESHOLD = 0.5;

/**
 * The request that tags one message's paragraphs, with the paragraphs
 * before them, most recent last, as context.
 */
export function taggingRequest(
	units: readonly SelectionUnit[],
	before: readonly SelectionUnit[],
	contextTokens = TAGGING_CONTEXT_TOKENS,
): ClassificationRequest {
	const questions: Record<string, ClassificationQuestion> = {};
	units.forEach((unit, at) => {
		for (const kind of kindsFor(unit.speaker)) {
			questions[questionId(at, kind)] = {
				unit: unitId(at),
				...KIND_DEFINITIONS[kind].tag,
			};
		}
	});
	return {
		contract: CLASSIFICATION_CONTRACT,
		context: recentContext(before, contextTokens),
		units: units.map((unit, at) => ({
			id: unitId(at),
			text: unit.text,
			speaker: unit.speaker,
		})),
		questions,
	};
}

/** Each paragraph's kinds, read out of the answers to its request. */
export function tagsFrom(
	units: readonly SelectionUnit[],
	answers: ClassificationAnswers,
	threshold = TAG_THRESHOLD,
): UnitTags[] {
	return units.map((unit, at) => ({
		hash: unit.hash,
		kinds: kindsFor(unit.speaker).filter(
			(kind) => (answers[questionId(at, kind)] ?? 0) >= threshold,
		),
	}));
}

/**
 * The latest paragraphs that fit a token budget, in the order they
 * were said. Always at least one when there is one, so a long previous
 * message still gives a reply something to read against.
 */
export function recentContext(
	before: readonly SelectionUnit[],
	tokens: number,
): ClassificationUnit[] {
	const kept: ClassificationUnit[] = [];
	let spent = 0;
	for (let at = before.length - 1; at >= 0; at--) {
		const unit = before[at];
		if (!unit) continue;
		const cost = estimatedTokens(unit.text);
		if (kept.length > 0 && spent + cost > tokens) break;
		spent += cost;
		kept.unshift({ id: `c${at}`, text: unit.text, speaker: unit.speaker });
	}
	return kept;
}

function unitId(at: number): string {
	return `u${at}`;
}

function questionId(at: number, kind: SelectionKind): string {
	return `${unitId(at)}.${kind}`;
}
