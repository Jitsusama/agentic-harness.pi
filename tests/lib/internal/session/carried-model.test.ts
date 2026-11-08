import { afterEach, describe, expect, it } from "vitest";
import {
	authOf,
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

describe("how a provider authenticated", () => {
	it("keeps its registration's key, address and headers, with the variables they name", () => {
		const env = { SHOPIFY_PROXY_KEY: "k", TAG: "t", UNUSED: "u" };
		// biome-ignore lint/suspicious/noTemplateCurlyInString: pi's braced variable reference, read as written.
		const tag = "${TAG}-$$5";
		expect(
			authOf(
				{
					apiKey: "$SHOPIFY_PROXY_KEY",
					baseUrl: "https://proxy.invalid/apis/anthropic",
					headers: { tag, count: 3 },
				},
				env,
			),
		).toEqual({
			config: {
				apiKey: "$SHOPIFY_PROXY_KEY",
				baseUrl: "https://proxy.invalid/apis/anthropic",
				headers: { tag },
			},
			variables: { SHOPIFY_PROXY_KEY: "k", TAG: "t" },
		});
	});

	it("names no variable a command's key or an unset one would", () => {
		expect(authOf({ apiKey: "!print-key $HOME" }, { HOME: "/h" })).toEqual({
			config: { apiKey: "!print-key $HOME" },
			variables: {},
		});
		expect(authOf({ apiKey: "$GONE" }, {})?.variables).toEqual({});
	});

	it("is nothing for a provider not registered by config", () => {
		expect(authOf(undefined, {})).toBeUndefined();
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
		expect(hasNoModel(undefined), "no model at all is none").toBe(true);
		expect(
			hasNoModel({ provider: NO_PROVIDER }),
			"pi's placeholder provider is none",
		).toBe(true);
		expect(
			hasNoModel({ provider: "anthropic" }),
			"a real provider is a model",
		).toBe(false);
	});
});
