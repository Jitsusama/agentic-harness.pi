/**
 * Asking a model a classification request and reading its answers.
 *
 * The call itself is handed in, so this module knows nothing of
 * credentials or which provider serves the model. An extension passes
 * one that goes through pi's model registry, which is what lets the
 * owner's model config decide what answers.
 */

import type {
	AssistantMessage,
	Context,
	ToolCall,
	Usage,
} from "@earendil-works/pi-ai";
import {
	ANSWER_TOOL_NAME,
	type ClassificationAnswers,
	type ClassificationRequest,
} from "./contract.ts";
import { classificationContext } from "./prompt.ts";

/** Sends a context to the classifier model and resolves with its reply. */
export type ClassifierCall = (
	context: Context,
	signal?: AbortSignal,
) => Promise<AssistantMessage>;

/** What a classification came to. */
export type Classification =
	| {
			readonly ok: true;
			readonly answers: ClassificationAnswers;
			/** Question ids the reply left out, which have no answer at all. */
			readonly missing: readonly string[];
			readonly usage: Usage;
			/** The model that answered, as the reply named it. */
			readonly model: string;
	  }
	| {
			readonly ok: false;
			readonly reason: string;
			/** What the call cost, when it got far enough to say. */
			readonly usage?: Usage;
	  };

/** Ask a classification request and read the answers out of the reply. */
export async function classify(
	call: ClassifierCall,
	request: ClassificationRequest,
	signal?: AbortSignal,
): Promise<Classification> {
	if (Object.keys(request.questions).length === 0) {
		return { ok: false, reason: "the request asks no questions" };
	}
	let reply: AssistantMessage;
	try {
		reply = await call(classificationContext(request), signal);
	} catch (error) {
		return {
			ok: false,
			reason: error instanceof Error ? error.message : String(error),
		};
	}
	return readAnswers(request, reply);
}

/**
 * The answers in a reply to a request. Only the request's own
 * questions are read, a probability outside 0 to 1 is held to it, and
 * a question the reply skipped is listed as missing rather than given
 * an answer nobody gave.
 */
export function readAnswers(
	request: ClassificationRequest,
	reply: AssistantMessage,
): Classification {
	const { usage } = reply;
	if (reply.stopReason === "error" || reply.stopReason === "aborted") {
		return {
			ok: false,
			reason: reply.errorMessage ?? `the call ended with ${reply.stopReason}`,
			usage,
		};
	}
	const call = reply.content.find(
		(part): part is ToolCall =>
			part.type === "toolCall" && part.name === ANSWER_TOOL_NAME,
	);
	if (!call) {
		return {
			ok: false,
			reason: "the reply did not call the answer tool",
			usage,
		};
	}
	const given = call.arguments.answers;
	if (typeof given !== "object" || given === null || Array.isArray(given)) {
		return {
			ok: false,
			reason: "the answer tool was called without answers",
			usage,
		};
	}
	const answers: Record<string, number> = {};
	const missing: string[] = [];
	for (const id of Object.keys(request.questions)) {
		const value = (given as Record<string, unknown>)[id];
		if (typeof value === "number" && Number.isFinite(value)) {
			answers[id] = Math.min(1, Math.max(0, value));
		} else {
			missing.push(id);
		}
	}
	if (missing.length === Object.keys(request.questions).length) {
		return {
			ok: false,
			reason: "the reply answered none of the questions",
			usage,
		};
	}
	return {
		ok: true,
		answers,
		missing,
		usage,
		model: reply.responseModel ?? reply.model,
	};
}
