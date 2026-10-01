import type {
	ClassifierContext,
	ClassifierResult,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	aboutParagraph,
	classifierContext,
	classify,
} from "../../../../lib/compaction/selection/classify.ts";

const USAGE = {
	input: 300,
	output: 20,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 320,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const QUESTION = { ask: "Is it a rule?", yes: "It is.", no: "It is not." };

const context = classifierContext(
	[{ id: "c0", speaker: "user", text: "Before." }],
	[{ id: "u0", speaker: "user", text: "Always sign commits." }],
	{
		"u0.rule": aboutParagraph("u0", QUESTION),
		"u0.goal": aboutParagraph("u0", QUESTION),
	},
);

function answering(
	answers: ClassifierResult["answers"],
	overrides: Partial<ClassifierResult> = {},
) {
	return async (_context: ClassifierContext): Promise<ClassifierResult> => ({
		api: "test",
		provider: "local",
		model: "jev",
		answers,
		usage: USAGE,
		stopReason: "stop",
		timestamp: 0,
		...overrides,
	});
}

describe("asking a classifier", () => {
	it("puts paragraphs and context in the state, each question naming its paragraph", () => {
		expect(context.state).toEqual({
			context: [{ id: "c0", speaker: "user", text: "Before." }],
			paragraphs: [{ id: "u0", speaker: "user", text: "Always sign commits." }],
		});
		expect(context.questions["u0.rule"]).toEqual({
			type: "bool",
			instructions:
				"About paragraph u0 in `paragraphs`, read against `context`: Is it a rule?",
			criteria: { true: "It is.", false: "It is not." },
		});
	});

	it("reads bool answers held to 0 to 1, and lists what it left out", async () => {
		const result = await classify(
			answering({ "u0.rule": { type: "bool", probability: 1.4 } }),
			context,
		);
		expect(result).toEqual({
			ok: true,
			answers: { "u0.rule": 1 },
			missing: ["u0.goal"],
			usage: USAGE,
			model: "jev",
		});
	});

	it("fails when nothing is answered, keeping what it cost", async () => {
		const result = await classify(
			answering({ "u0.rule": { type: "score", score: 1, confidence: 1 } }),
			context,
		);
		expect(result).toEqual({
			ok: false,
			reason: "the result answered none of the questions",
			usage: USAGE,
		});
	});

	it("fails on a call that did not stop, or that threw", async () => {
		expect(
			await classify(
				answering({}, { stopReason: "aborted", usage: undefined }),
				context,
			),
		).toEqual({ ok: false, reason: "the call ended with aborted" });
		expect(
			await classify(async () => {
				throw new Error("offline");
			}, context),
		).toEqual({ ok: false, reason: "offline" });
		expect(await classify(answering({}), { state: {}, questions: {} })).toEqual(
			{ ok: false, reason: "the request asks no questions" },
		);
	});
});
