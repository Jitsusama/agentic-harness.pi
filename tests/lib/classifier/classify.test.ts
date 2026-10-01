import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	ANSWER_TOOL_NAME,
	CLASSIFICATION_CONTRACT,
	type ClassificationRequest,
	classificationContext,
	classify,
	requestFromContext,
} from "../../../lib/classifier/index.ts";

const USAGE = {
	input: 100,
	output: 20,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 120,
	cost: {
		input: 0.001,
		output: 0.0005,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0.0015,
	},
};

const REQUEST: ClassificationRequest = {
	contract: CLASSIFICATION_CONTRACT,
	context: [{ id: "c1", text: "Earlier talk.", speaker: "assistant" }],
	units: [{ id: "u1", text: "Never push to main.", speaker: "user" }],
	questions: {
		"u1:rule": {
			unit: "u1",
			ask: "Does this set a standing rule?",
			yes: "It says how work must always or never be done.",
			no: "It is about this moment only.",
		},
		"u1:goal": {
			unit: "u1",
			ask: "Does this state a goal?",
			yes: "It says what the work is for.",
			no: "It does not.",
		},
	},
};

function reply(
	content: AssistantMessage["content"],
	overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "small-model",
		usage: USAGE,
		stopReason: "toolUse",
		timestamp: 0,
		...overrides,
	};
}

function answering(answers: unknown) {
	return reply([
		{
			type: "toolCall",
			id: "t1",
			name: ANSWER_TOOL_NAME,
			arguments: { answers } as never,
		},
	]);
}

describe("classificationContext", () => {
	it("carries the request as JSON with the answer tool", () => {
		const context = classificationContext(REQUEST);
		expect(context.tools?.map((t) => t.name)).toEqual([ANSWER_TOOL_NAME]);
		expect(context.systemPrompt).toContain(
			`calling the ${ANSWER_TOOL_NAME} tool`,
		);
		expect(requestFromContext(context)).toEqual(REQUEST);
	});
});

describe("requestFromContext", () => {
	it("finds nothing in a context this contract did not write", () => {
		const context: Context = {
			messages: [{ role: "user", content: "hello", timestamp: 0 }],
		};
		expect(requestFromContext(context)).toBeUndefined();
	});

	it("reads a request sent as a plain string", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: JSON.stringify(REQUEST), timestamp: 0 },
			],
		};
		expect(requestFromContext(context)).toEqual(REQUEST);
	});
});

describe("classify", () => {
	it("reads each question's probability and the model that answered", async () => {
		const sent: Context[] = [];
		const result = await classify(async (context) => {
			sent.push(context);
			return answering({ "u1:rule": 0.93, "u1:goal": 0.1 });
		}, REQUEST);

		expect(result).toEqual({
			ok: true,
			answers: { "u1:rule": 0.93, "u1:goal": 0.1 },
			missing: [],
			usage: USAGE,
			model: "small-model",
		});
		expect(sent).toHaveLength(1);
	});

	it("holds probabilities to 0 and 1 and ignores questions nobody asked", async () => {
		const result = await classify(
			async () => answering({ "u1:rule": 1.4, "u1:goal": -2, extra: 0.5 }),
			REQUEST,
		);
		expect(result.ok && result.answers).toEqual({ "u1:rule": 1, "u1:goal": 0 });
	});

	it("lists a skipped question as missing rather than answering it", async () => {
		const result = await classify(
			async () => answering({ "u1:rule": 0.8 }),
			REQUEST,
		);
		expect(result.ok && result.missing).toEqual(["u1:goal"]);
		expect(result.ok && "u1:goal" in result.answers).toBe(false);
	});

	it("fails with the cost when the reply answers in text", async () => {
		const result = await classify(
			async () =>
				reply([{ type: "text", text: "yes" }], { stopReason: "stop" }),
			REQUEST,
		);
		expect(result).toEqual({
			ok: false,
			reason: "the reply did not call the answer tool",
			usage: USAGE,
		});
	});

	it("fails when no question is answered", async () => {
		const result = await classify(async () => answering({ other: 1 }), REQUEST);
		expect(result.ok).toBe(false);
	});

	it("fails with the provider's message when the call errored", async () => {
		const result = await classify(
			async () =>
				reply([], { stopReason: "error", errorMessage: "overloaded" }),
			REQUEST,
		);
		expect(result).toMatchObject({ ok: false, reason: "overloaded" });
	});

	it("fails rather than throws when the call throws", async () => {
		const result = await classify(async () => {
			throw new Error("no route");
		}, REQUEST);
		expect(result).toEqual({ ok: false, reason: "no route" });
	});

	it("does not call the model for a request with no questions", async () => {
		let called = false;
		const result = await classify(
			async () => {
				called = true;
				return answering({});
			},
			{ ...REQUEST, questions: {} },
		);
		expect(result.ok).toBe(false);
		expect(called).toBe(false);
	});
});
