/**
 * Asking a classifier model about paragraphs, in the shape pi's
 * classifier models take: JSON state, and typed questions answered with
 * probabilities.
 *
 * The paragraphs asked about and the ones given only as context go in
 * the state under their own keys, each with an id, and every question
 * names the paragraph it is about by that id. Each is a `bool`
 * question, read as the probability that the answer is yes.
 *
 * The call itself is handed in, so nothing here knows which model or
 * provider answers. An extension passes one that goes through pi's
 * model registry.
 */

import type {
	ClassifierBoolQuestion,
	ClassifierContext,
	ClassifierResult,
	Usage,
} from "@earendil-works/pi-ai";
import type { KindQuestion } from "./kinds.ts";

/** One paragraph as the classifier is shown it. */
export interface Passage {
	readonly id: string;
	readonly speaker: "user" | "assistant";
	readonly text: string;
}

/** Sends a context to a classifier model and resolves with its result. */
export type Classifier = (
	context: ClassifierContext,
	signal?: AbortSignal,
) => Promise<ClassifierResult>;

/** What asking came to. */
export type Classification =
	| {
			readonly ok: true;
			/** For each question id, the probability from 0 to 1 that it is yes. */
			readonly answers: Readonly<Record<string, number>>;
			/** Question ids the result left out, which have no answer at all. */
			readonly missing: readonly string[];
			readonly usage?: Usage;
			/** The model that answered. */
			readonly model: string;
	  }
	| {
			readonly ok: false;
			readonly reason: string;
			/** What the call cost, when it got far enough to say. */
			readonly usage?: Usage;
	  };

/** The questions about some paragraphs, with others around them as context. */
export function classifierContext(
	context: readonly Passage[],
	paragraphs: readonly Passage[],
	questions: Readonly<Record<string, ClassifierBoolQuestion>>,
): ClassifierContext {
	return {
		state: {
			context: context.map(asJson),
			paragraphs: paragraphs.map(asJson),
		},
		questions: { ...questions },
	};
}

/** A question about the paragraph with this id. */
export function aboutParagraph(
	id: string,
	question: KindQuestion,
): ClassifierBoolQuestion {
	return {
		type: "bool",
		instructions: `About paragraph ${id} in \`paragraphs\`, read against \`context\`: ${question.ask}`,
		criteria: { true: question.yes, false: question.no },
	};
}

/**
 * Ask a classifier and read its answers. Only the context's own
 * questions are read, a probability outside 0 to 1 is held to it, and a
 * question the result skipped is listed as missing rather than given an
 * answer nobody gave.
 */
export async function classify(
	classifier: Classifier,
	context: ClassifierContext,
	signal?: AbortSignal,
): Promise<Classification> {
	const ids = Object.keys(context.questions);
	if (ids.length === 0) {
		return { ok: false, reason: "the request asks no questions" };
	}
	let result: ClassifierResult;
	try {
		result = await classifier(context, signal);
	} catch (error) {
		return {
			ok: false,
			reason: error instanceof Error ? error.message : String(error),
		};
	}
	const { usage } = result;
	if (result.stopReason !== "stop") {
		return {
			ok: false,
			reason: result.errorMessage ?? `the call ended with ${result.stopReason}`,
			...(usage ? { usage } : {}),
		};
	}
	const answers: Record<string, number> = {};
	const missing: string[] = [];
	for (const id of ids) {
		const answer = result.answers[id];
		if (
			answer?.type === "bool" &&
			typeof answer.probability === "number" &&
			Number.isFinite(answer.probability)
		) {
			answers[id] = Math.min(1, Math.max(0, answer.probability));
		} else {
			missing.push(id);
		}
	}
	if (missing.length === ids.length) {
		return {
			ok: false,
			reason: "the result answered none of the questions",
			...(usage ? { usage } : {}),
		};
	}
	return {
		ok: true,
		answers,
		missing,
		...(usage ? { usage } : {}),
		model: result.model,
	};
}

function asJson(passage: Passage): {
	id: string;
	speaker: string;
	text: string;
} {
	return { id: passage.id, speaker: passage.speaker, text: passage.text };
}
