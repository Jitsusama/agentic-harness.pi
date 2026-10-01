/**
 * The classification contract: yes-or-no questions about short units
 * of text, answered with the probability that each answer is yes.
 *
 * It is carried as an ordinary chat request so any model can answer
 * it: a system message saying what to do, one user message holding
 * the request as JSON, and one tool, {@link ANSWER_TOOL_NAME}, that
 * the model calls with its answers. A general chat model answers with
 * probabilities near 0 or 1. A model built for classification can be
 * put behind the same request by a provider in pi's model config that
 * reads the request out of the user message and answers with the
 * tool call, which is the only piece that needs to know who serves it.
 *
 * The name is versioned because the shape is a contract between this
 * package and whatever answers it; a breaking change ships as `v2`.
 */

/** Names this shape of request in the JSON the model is sent. */
export const CLASSIFICATION_CONTRACT = "classification/v1";

/** The tool the model answers through. */
export const ANSWER_TOOL_NAME = "answer";

/** One short unit of text, such as a paragraph. */
export interface ClassificationUnit {
	readonly id: string;
	readonly text: string;
	/** Who wrote it, when that matters to the questions. */
	readonly speaker?: "user" | "assistant";
}

/** One yes-or-no question about one unit. */
export interface ClassificationQuestion {
	/** The id of the unit the question is about. */
	readonly unit: string;
	readonly ask: string;
	/** What makes the answer yes. */
	readonly yes: string;
	/** What makes the answer no. */
	readonly no: string;
}

/** Questions about some units, with the text around them. */
export interface ClassificationRequest {
	readonly contract: typeof CLASSIFICATION_CONTRACT;
	/** Background the questions may need; nothing here is asked about. */
	readonly context: readonly ClassificationUnit[];
	/** The units the questions are about. */
	readonly units: readonly ClassificationUnit[];
	/** Every question, by its id. */
	readonly questions: Readonly<Record<string, ClassificationQuestion>>;
}

/** For each question id, the probability from 0 to 1 that it is yes. */
export type ClassificationAnswers = Readonly<Record<string, number>>;

/** Whether a value is a classification request this contract describes. */
export function isClassificationRequest(
	value: unknown,
): value is ClassificationRequest {
	if (typeof value !== "object" || value === null) return false;
	const request = value as Record<string, unknown>;
	return (
		request.contract === CLASSIFICATION_CONTRACT &&
		Array.isArray(request.context) &&
		Array.isArray(request.units) &&
		typeof request.questions === "object" &&
		request.questions !== null
	);
}
