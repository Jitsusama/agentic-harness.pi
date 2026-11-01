import { describe, expect, it } from "vitest";
import {
	personsWords,
	refusedModel,
} from "../../../../lib/internal/session/asked-models.ts";

const OPUS = "anthropic/claude-opus-5-5";

describe("a model the agent names for a fleet or a round", () => {
	it("runs when it is the usual one, with or without its provider", () => {
		expect(refusedModel(OPUS, OPUS, [])).toBeUndefined();
		expect(refusedModel("claude-opus-5-5", OPUS, [])).toBeUndefined();
	});

	it("runs whatever it is when nothing is usual", () => {
		expect(refusedModel("openai/gpt-5.5", undefined, [])).toBeUndefined();
	});

	it("is refused when it is another, saying to vary personas instead", () => {
		const refused = refusedModel("openai/gpt-5.5", OPUS, ["review this"]);
		expect(refused).toContain("openai/gpt-5.5 is refused");
		expect(refused).toContain(OPUS);
		expect(refused).toContain("distinct persona");
		expect(
			refusedModel("google/gemini-3-pro", OPUS, ["get several views"]),
		).toBeDefined();
		expect(refusedModel("anthropic/claude-opus-4-1", OPUS, [])).toBeDefined();
	});

	it("runs when the person named it, by its family or its id", () => {
		expect(
			refusedModel("openai/gpt-5.5", OPUS, ["ask GPT for a second look"]),
		).toBeUndefined();
		expect(
			refusedModel("google/gemini-3-pro", OPUS, ["try gemini on this"]),
		).toBeUndefined();
		expect(
			refusedModel("anthropic/claude-sonnet-5", OPUS, ["use Sonnet"]),
		).toBeUndefined();
		expect(
			refusedModel("anthropic/claude-opus-4-1", OPUS, [
				"run it on claude opus 4.1",
			]),
		).toBeUndefined();
	});

	it("is still refused when the person named only what it shares with the usual one", () => {
		expect(
			refusedModel("anthropic/claude-opus-4-1", OPUS, ["use claude opus"]),
		).toBeDefined();
		expect(
			refusedModel("openai/gpt-5.5", OPUS, ["a cryptographic review"]),
		).toBeDefined();
	});
});

describe("what the person typed", () => {
	it("keeps the newest few, oldest dropped first", () => {
		const words = personsWords(2);
		words.heard("one");
		words.heard("two");
		words.heard("three");
		expect(words.said).toEqual(["two", "three"]);
	});
});
