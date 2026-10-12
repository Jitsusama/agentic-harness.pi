import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";
import ask from "../../../extensions/ask-workflow/index.ts";
import {
	comeBack,
	goAway,
	resetAway,
} from "../../../lib/internal/away/state.ts";

interface Tool {
	execute: (
		id: string,
		params: unknown,
		signal: undefined,
		onUpdate: undefined,
		ctx: unknown,
	) => Promise<{ content: { type: string; text: string }[] }>;
}

let tool: Tool;

beforeEach(() => {
	resetAway();
	const pi = {
		registerTool: (definition: Tool) => {
			tool = definition;
		},
	};
	ask(pi as unknown as ExtensionAPI);
});

const QUESTION = {
	id: "scope",
	prompt: "Which scope?",
	options: [
		{ value: "small", label: "Small" },
		{ value: "large", label: "Large" },
	],
};

async function asked(question: Record<string, unknown>): Promise<string> {
	const result = await tool.execute(
		"t1",
		{ questions: [question] },
		undefined,
		undefined,
		{
			hasUI: true,
		},
	);
	return result.content[0]?.text ?? "";
}

describe("ask while the user is away", () => {
	beforeEach(() => {
		goAway();
	});

	it("takes the recommendation without asking, and keeps the decision", async () => {
		const text = await asked({ ...QUESTION, recommended: "large" });

		expect(text).toContain("took your recommendation: 2. Large");
		expect(comeBack()?.decided).toMatchObject([
			{ question: "Which scope?", answer: "Large", by: "recommendation" },
		]);
	});

	it("hands a question with no recommendation back to the asker", async () => {
		const text = await asked(QUESTION);

		expect(text).toContain("decide from the evidence");
		expect(comeBack()?.decided).toMatchObject([{ by: "model" }]);
	});

	it("does not need a UI to answer", async () => {
		const result = await tool.execute(
			"t1",
			{ questions: [{ ...QUESTION, recommended: "small" }] },
			undefined,
			undefined,
			{ hasUI: false },
		);

		expect(result.content[0]?.text).toContain("1. Small");
	});
});
