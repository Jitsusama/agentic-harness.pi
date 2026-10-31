import { afterEach, describe, expect, it } from "vitest";
import {
	carryModel,
	hasNoModel,
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

describe("a session on no model", () => {
	it("has none, or pi's placeholder", () => {
		expect(hasNoModel(undefined)).toBe(true);
		expect(hasNoModel({ provider: NO_PROVIDER })).toBe(true);
		expect(hasNoModel({ provider: "anthropic" })).toBe(false);
	});
});
