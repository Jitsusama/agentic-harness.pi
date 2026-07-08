import { describe, expect, it } from "vitest";
import {
	looksLikeGlm,
	type ModelRef,
	pickModel,
} from "../../../lib/completion/resolve.js";

const glm: ModelRef = { id: "glm-5.2", provider: "fireworks" };
const opus: ModelRef = { id: "claude-opus-4-8", provider: "anthropic" };
const gpt: ModelRef = { id: "gpt-5", provider: "openai" };

describe("looksLikeGlm", () => {
	it("matches on id or provider, case-insensitively", () => {
		expect(looksLikeGlm(glm)).toBe(true);
		expect(looksLikeGlm({ id: "x", provider: "z-ai" })).toBe(true);
		expect(looksLikeGlm({ id: "y", provider: "Zhipu" })).toBe(true);
		expect(looksLikeGlm(opus)).toBe(false);
	});
});

describe("pickModel", () => {
	const available = [opus, gpt, glm];

	it("resolves an explicit provider and model through find", () => {
		const find = (p: string, m: string) =>
			p === "openai" && m === "gpt-5" ? gpt : undefined;
		expect(
			pickModel(available, opus, { provider: "openai", model: "gpt-5" }, find),
		).toBe(gpt);
	});

	it("matches an explicit model id against the available list", () => {
		expect(pickModel(available, opus, { model: "gpt-5" })).toBe(gpt);
	});

	it("prefers a GLM model when no target is given", () => {
		expect(pickModel(available, opus, {})).toBe(glm);
	});

	it("honours a provider named without a model", () => {
		expect(pickModel(available, glm, { provider: "openai" })).toBe(gpt);
	});

	it("falls back to the current model when no GLM is present", () => {
		expect(pickModel([opus, gpt], opus, {})).toBe(opus);
	});

	it("returns undefined when nothing fits and there is no current", () => {
		expect(pickModel([], undefined, {})).toBeUndefined();
	});

	it("falls through a failed find to a name match", () => {
		const find = () => undefined;
		expect(
			pickModel(available, opus, { provider: "x", model: "gpt-5" }, find),
		).toBe(gpt);
	});
});
