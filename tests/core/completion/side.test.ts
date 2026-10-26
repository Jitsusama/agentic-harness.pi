import { describe, expect, it, vi } from "vitest";
import { runSideCompletion } from "../../../lib/core/completion/side.ts";
import type {
	CompleteSimple,
	CompletionRegistry,
} from "../../../lib/core/completion/types.ts";

const glm = { id: "glm-5.2", provider: "fireworks" };

/** A `complete` stub that is never expected to run. */
const unreachable: CompleteSimple = vi.fn(() => {
	throw new Error("complete should not have been called");
});

describe("runSideCompletion error paths", () => {
	it("returns not-ok when no model is available", async () => {
		const registry: CompletionRegistry = {
			getAvailable: () => [],
			find: () => undefined,
			getApiKeyAndHeaders: async () => ({ ok: true }),
		};
		const result = await runSideCompletion(
			registry,
			{ systemPrompt: "s", prompt: "hi" },
			unreachable,
		);
		expect(result.ok).toBe(false);
		expect(result.error).toContain("no model");
	});

	it("surfaces an auth-not-configured failure with the model named", async () => {
		const registry: CompletionRegistry = {
			getAvailable: () => [glm],
			find: () => undefined,
			getApiKeyAndHeaders: async () => ({ ok: false, error: "no key" }),
		};
		const result = await runSideCompletion(
			registry,
			{ systemPrompt: "s" },
			unreachable,
		);
		expect(result.ok).toBe(false);
		expect(result.provider).toBe("fireworks");
		expect(result.model).toBe("glm-5.2");
		expect(result.error).toContain("auth not configured");
	});

	it("surfaces a throwing auth resolution", async () => {
		const registry: CompletionRegistry = {
			getAvailable: () => [glm],
			find: () => undefined,
			getApiKeyAndHeaders: async () => {
				throw new Error("boom");
			},
		};
		const result = await runSideCompletion(
			registry,
			{ systemPrompt: "s" },
			unreachable,
		);
		expect(result.ok).toBe(false);
		expect(result.error).toContain("auth resolution threw");
		expect(result.error).toContain("boom");
	});
});

const flash = { id: "glm-5p3-flash", provider: "fireworks" };
const opus = { id: "claude-opus", provider: "anthropic" };
const notDeployed =
	'404 {"error":{"message":"Model not found, inaccessible, and/or not deployed"}}';

/** A completion result that reports an error. */
function failed(errorMessage: string) {
	return {
		content: [],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage,
	};
}

describe("runSideCompletion when a listed model cannot be reached", () => {
	// A registry can list a model its provider no longer serves, so the
	// first cheap model is not always one that answers.
	it("moves on to the next model when one is not deployed", async () => {
		const tried: string[] = [];
		const registry: CompletionRegistry = {
			getAvailable: () => [opus, glm, flash],
			find: () => undefined,
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }),
		};
		const complete: CompleteSimple = async (model) => {
			tried.push(model.id);
			if (model.id === glm.id) return failed(notDeployed);
			return {
				content: [{ type: "text", text: "drafted" }],
				usage: failed("").usage,
				stopReason: "end",
			};
		};

		const result = await runSideCompletion(
			registry,
			{ systemPrompt: "s", prompt: "hi", current: opus },
			complete,
		);

		expect(tried).toEqual(["glm-5.2", "glm-5p3-flash"]);
		expect(result.ok).toBe(true);
		expect(result.text).toBe("drafted");
		expect(result.model).toBe("glm-5p3-flash");
	});

	it("moves on to the next model when one has no auth", async () => {
		const tried: string[] = [];
		const registry: CompletionRegistry = {
			getAvailable: () => [glm, flash],
			find: () => undefined,
			getApiKeyAndHeaders: async (model) =>
				model.id === glm.id
					? { ok: false, error: "no key" }
					: { ok: true, apiKey: "k" },
		};
		const complete: CompleteSimple = async (model) => {
			tried.push(model.id);
			return {
				content: [{ type: "text", text: "ok" }],
				usage: failed("").usage,
				stopReason: "end",
			};
		};

		const result = await runSideCompletion(
			registry,
			{ systemPrompt: "s", prompt: "hi" },
			complete,
		);

		expect(tried).toEqual(["glm-5p3-flash"]);
		expect(result.ok).toBe(true);
	});

	it("falls back to the current model last and names every model tried", async () => {
		const tried: string[] = [];
		const registry: CompletionRegistry = {
			getAvailable: () => [opus, glm, flash],
			find: () => undefined,
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }),
		};
		const complete: CompleteSimple = async (model) => {
			tried.push(model.id);
			return failed(notDeployed);
		};

		const result = await runSideCompletion(
			registry,
			{ systemPrompt: "s", prompt: "hi", current: opus },
			complete,
		);

		expect(tried).toEqual(["glm-5.2", "glm-5p3-flash", "claude-opus"]);
		expect(result.ok).toBe(false);
		expect(result.error).toContain("fireworks/glm-5.2: 404");
		expect(result.error).toContain("fireworks/glm-5p3-flash: 404");
		expect(result.error).toContain("anthropic/claude-opus: 404");
	});
});

describe("runSideCompletion against a fake completion backend", () => {
	const registry: CompletionRegistry = {
		getAvailable: () => [glm],
		find: () => undefined,
		getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }),
	};

	it("returns the completed text on success", async () => {
		const complete: CompleteSimple = async (model, context) => {
			expect(model).toEqual(glm);
			expect(context.systemPrompt).toBe("s");
			return {
				content: [{ type: "text", text: "hello" }],
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "end",
			};
		};

		const result = await runSideCompletion(
			registry,
			{ systemPrompt: "s", prompt: "hi" },
			complete,
		);

		expect(result.ok).toBe(true);
		expect(result.text).toBe("hello");
		expect(result.usage?.totalTokens).toBe(2);
	});

	it("passes a null header through, since pi reads it as suppressing a default", async () => {
		const suppressing: CompletionRegistry = {
			getAvailable: () => [glm],
			find: () => undefined,
			getApiKeyAndHeaders: async () => ({
				ok: true,
				headers: { "x-kept": "v", "x-default": null },
			}),
		};
		let sent: unknown;
		const complete: CompleteSimple = async (_model, _context, options) => {
			sent = options.headers;
			return {
				content: [{ type: "text", text: "ok" }],
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "end",
			};
		};

		await runSideCompletion(
			suppressing,
			{ systemPrompt: "s", prompt: "hi" },
			complete,
		);

		expect(sent).toEqual({ "x-kept": "v", "x-default": null });
	});

	it("reports not-ok when the completion itself errors", async () => {
		const complete: CompleteSimple = async () => ({
			content: [],
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage: "backend refused",
		});

		const result = await runSideCompletion(
			registry,
			{ systemPrompt: "s", prompt: "hi" },
			complete,
		);

		expect(result.ok).toBe(false);
		expect(result.error).toBe("backend refused");
	});

	it("stays on the model when its error is not about the model being there", async () => {
		const tried: string[] = [];
		const two: CompletionRegistry = {
			getAvailable: () => [glm, flash],
			find: () => undefined,
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }),
		};
		const complete: CompleteSimple = async (model) => {
			tried.push(model.id);
			return failed("rate limited");
		};

		const result = await runSideCompletion(
			two,
			{ systemPrompt: "s", prompt: "hi" },
			complete,
		);

		expect(tried).toEqual(["glm-5.2"]);
		expect(result.ok).toBe(false);
		expect(result.error).toBe("rate limited");
	});

	it("surfaces a throwing completion call", async () => {
		const complete: CompleteSimple = async () => {
			throw new Error("network down");
		};

		const result = await runSideCompletion(
			registry,
			{ systemPrompt: "s", prompt: "hi" },
			complete,
		);

		expect(result.ok).toBe(false);
		expect(result.error).toContain("completion threw");
		expect(result.error).toContain("network down");
	});
});
