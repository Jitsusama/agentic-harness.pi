/**
 * The classification request as a chat request, and back again.
 *
 * A request becomes a pi-ai context: instructions in the system
 * prompt, the request itself as JSON in the one user message, and the
 * answer tool. The reverse, {@link requestFromContext}, is for a
 * provider in pi's model config that serves a classifier: it reads
 * the request back out of the context it was handed rather than
 * parsing the instructions.
 */

import type { Context, Tool } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import {
	ANSWER_TOOL_NAME,
	type ClassificationRequest,
	isClassificationRequest,
} from "./contract.ts";

const ANSWER_TOOL: Tool = {
	name: ANSWER_TOOL_NAME,
	description:
		"Answer every question in the request. For each question id, give the probability from 0 to 1 that the answer is yes.",
	parameters: Type.Object({
		answers: Type.Record(
			Type.String(),
			Type.Number({ minimum: 0, maximum: 1 }),
		),
	}),
};

// The tool call is required in words because pi-ai's tool choice can
// only say whether tools may be used, not that one must be.
const INSTRUCTIONS = `You classify short units of text by answering yes-or-no questions about them.

The user message is a JSON request. "units" are the texts the questions are about, each with an id and sometimes who wrote it. "context" is text that came before them, there only to help you read them; nothing in it is asked about. "questions" maps each question id to the unit it is about, what it asks, what makes the answer yes and what makes it no.

Answer by calling the ${ANSWER_TOOL_NAME} tool exactly once, with an entry for every question id: the probability from 0 to 1 that the answer is yes. Judge each question on its own; a unit can be yes to several. Do not reply with text.`;

/** The chat request that asks a model a classification request. */
export function classificationContext(request: ClassificationRequest): Context {
	return {
		systemPrompt: INSTRUCTIONS,
		messages: [
			{
				role: "user",
				content: [{ type: "text", text: JSON.stringify(request) }],
				timestamp: Date.now(),
			},
		],
		tools: [ANSWER_TOOL],
	};
}

/**
 * The classification request a context carries, or undefined when it
 * carries none. Reads the last user message, which is where
 * {@link classificationContext} puts it.
 */
export function requestFromContext(
	context: Context,
): ClassificationRequest | undefined {
	const last = [...context.messages].reverse().find((m) => m.role === "user");
	if (last?.role !== "user") return undefined;
	const text =
		typeof last.content === "string"
			? last.content
			: last.content
					.map((part) => (part.type === "text" ? part.text : ""))
					.join("");
	try {
		const value: unknown = JSON.parse(text);
		return isClassificationRequest(value) ? value : undefined;
	} catch {
		// Not JSON, so not a request this contract wrote.
		return undefined;
	}
}
