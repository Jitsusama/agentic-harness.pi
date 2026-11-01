import { afterEach, describe, expect, it } from "vitest";
import {
	carryModel,
	hasNoModel,
	modelOfBranch,
	NO_PROVIDER,
	takeCarriedModel,
} from "../../../../lib/internal/session/carried-model.ts";

const carried = {
	path: "/sessions/fresh.jsonl",
	provider: "anthropic",
	modelId: "claude-opus-5-5",
	thinkingLevel: "high" as const,
};

afterEach(() => {
	takeCarriedModel(undefined);
});

describe("the model carried across a rollover", () => {
	it("is taken by the log it was carried to, once", () => {
		carryModel(carried);

		expect(takeCarriedModel(carried.path)).toEqual(carried);
		expect(takeCarriedModel(carried.path)).toBeUndefined();
	});

	it("is no one's when another log starts", () => {
		carryModel(carried);

		expect(takeCarriedModel("/sessions/other.jsonl")).toBeUndefined();
		expect(takeCarriedModel(carried.path)).toBeUndefined();
	});

	it("is nothing when the session ran on no model", () => {
		carryModel({ ...carried, provider: NO_PROVIDER });

		expect(takeCarriedModel(carried.path)).toBeUndefined();
	});
});

describe("the model a log chose", () => {
	it("is its last model change, at its last thinking level", () => {
		const branch = [
			{
				type: "model_change",
				provider: "anthropic",
				modelId: "claude-opus-5-5",
			},
			{ type: "thinking_level_change", thinkingLevel: "high" },
			{ type: "message" },
			{ type: "model_change", provider: "openai", modelId: "gpt-5.5" },
			{ type: "thinking_level_change", thinkingLevel: "medium" },
		];

		expect(modelOfBranch(branch)).toEqual({
			provider: "openai",
			modelId: "gpt-5.5",
			thinkingLevel: "medium",
		});
	});

	it("passes over pi's placeholder, and is nothing when none was chosen", () => {
		const chosen = {
			type: "model_change",
			provider: "anthropic",
			modelId: "m",
		};
		const placeholder = {
			type: "model_change",
			provider: NO_PROVIDER,
			modelId: "unknown",
		};

		expect(modelOfBranch([chosen, placeholder])).toEqual({
			provider: "anthropic",
			modelId: "m",
		});
		expect(modelOfBranch([{ type: "message" }])).toBeUndefined();
	});
});

describe("a session on no model", () => {
	it("has none, or pi's placeholder", () => {
		expect(hasNoModel(undefined)).toBe(true);
		expect(hasNoModel({ provider: NO_PROVIDER })).toBe(true);
		expect(hasNoModel({ provider: "anthropic" })).toBe(false);
	});
});
