import { describe, expect, it } from "vitest";
import {
	isModelUnreachable,
	looksLikeGlm,
	type ModelRef,
	pickModel,
	rankModels,
} from "../../../lib/core/completion/resolve.ts";

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

describe("rankModels", () => {
	const flash: ModelRef = { id: "glm-5p3-flash", provider: "fireworks" };

	it("ranks every GLM model in registry order, then the current model", () => {
		expect(rankModels([opus, glm, gpt, flash], opus, {})).toEqual([
			glm,
			flash,
			opus,
		]);
	});

	it("puts an explicit target first and lists it once", () => {
		const find = (p: string, m: string) =>
			p === "fireworks" && m === "glm-5p3-flash" ? flash : undefined;
		expect(
			rankModels(
				[glm, flash],
				flash,
				{ provider: "fireworks", model: "glm-5p3-flash" },
				find,
			),
		).toEqual([flash, glm]);
	});

	it("is empty when nothing fits and there is no current", () => {
		expect(rankModels([opus, gpt], undefined, {})).toEqual([]);
	});
});

describe("isModelUnreachable", () => {
	it("reads not-found, not-deployed and refused-credential errors as unreachable", () => {
		expect(
			isModelUnreachable(
				'404 {"error":{"message":"Model not found, inaccessible, and/or not deployed"}}',
			),
		).toBe(true);
		expect(isModelUnreachable("model_not_found")).toBe(true);
		expect(isModelUnreachable("401 Unauthorized")).toBe(true);
	});

	it("leaves a failure of the request itself alone", () => {
		expect(isModelUnreachable("429 rate limited")).toBe(false);
		expect(isModelUnreachable("context length exceeded")).toBe(false);
		expect(isModelUnreachable("network down")).toBe(false);
	});
});
