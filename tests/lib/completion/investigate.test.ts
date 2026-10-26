import { describe, expect, it, vi } from "vitest";
import { runInvestigation } from "../../../lib/completion/investigate.ts";
import type {
	CompleteSimple,
	CompletionRegistry,
} from "../../../lib/completion/types.ts";

const glm = { id: "glm-5.2", provider: "fireworks" };

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** A `complete` stub that is never expected to run. */
const unreachable: CompleteSimple = vi.fn(() => {
	throw new Error("complete should not have been called");
});

const request = {
	systemPrompt: "s",
	messages: [] as unknown[],
	tools: [],
	maxSteps: 1,
};

describe("runInvestigation error paths", () => {
	it("returns not-ok when no model is available", async () => {
		const registry: CompletionRegistry = {
			getAvailable: () => [],
			find: () => undefined,
			getApiKeyAndHeaders: async () => ({ ok: true }),
		};

		const result = await runInvestigation(registry, request, unreachable);

		expect(result.ok).toBe(false);
		expect(result.error).toContain("no model");
	});

	it("surfaces an auth-not-configured failure with the model named", async () => {
		const registry: CompletionRegistry = {
			getAvailable: () => [glm],
			find: () => undefined,
			getApiKeyAndHeaders: async () => ({ ok: false, error: "no key" }),
		};

		const result = await runInvestigation(registry, request, unreachable);

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

		const result = await runInvestigation(registry, request, unreachable);

		expect(result.ok).toBe(false);
		expect(result.error).toContain("auth resolution threw");
		expect(result.error).toContain("boom");
	});
});

describe("runInvestigation when a listed model cannot be reached", () => {
	const flash = { id: "glm-5p3-flash", provider: "fireworks" };
	const notDeployed =
		'404 {"error":{"message":"Model not found, inaccessible, and/or not deployed"}}';
	const registry: CompletionRegistry = {
		getAvailable: () => [glm, flash],
		find: () => undefined,
		getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }),
	};

	it("moves on to the next model, keeping nothing from the one that failed", async () => {
		const tried: string[] = [];
		const complete: CompleteSimple = async (model) => {
			tried.push(model.id);
			if (model.id === glm.id) {
				return {
					content: [],
					usage: ZERO_USAGE,
					stopReason: "error",
					errorMessage: notDeployed,
				};
			}
			return {
				content: [{ type: "text", text: "clear" }],
				usage: ZERO_USAGE,
				stopReason: "end",
			};
		};
		const prior = [{ role: "user", content: "look", timestamp: 0 }];

		const result = await runInvestigation(
			registry,
			{ systemPrompt: "s", messages: prior, tools: [], maxSteps: 3 },
			complete,
		);

		expect(tried).toEqual(["glm-5.2", "glm-5p3-flash"]);
		expect(result.ok).toBe(true);
		expect(result.model).toBe("glm-5p3-flash");
		expect(result.steps).toBe(1);
		expect(result.messages).toHaveLength(2);
	});

	it("names every model tried when none can be reached", async () => {
		const complete: CompleteSimple = async () => {
			throw new Error(notDeployed);
		};

		const result = await runInvestigation(registry, request, complete);

		expect(result.ok).toBe(false);
		expect(result.error).toContain("fireworks/glm-5.2: completion threw: 404");
		expect(result.error).toContain(
			"fireworks/glm-5p3-flash: completion threw: 404",
		);
	});

	it("stays on the model when its error is not about the model being there", async () => {
		const tried: string[] = [];
		const complete: CompleteSimple = async (model) => {
			tried.push(model.id);
			return {
				content: [],
				usage: ZERO_USAGE,
				stopReason: "error",
				errorMessage: "rate limited",
			};
		};

		const result = await runInvestigation(registry, request, complete);

		expect(tried).toEqual(["glm-5.2"]);
		expect(result.ok).toBe(false);
		expect(result.error).toBe("rate limited");
	});
});

describe("runInvestigation against a fake completion backend", () => {
	const registry: CompletionRegistry = {
		getAvailable: () => [glm],
		find: () => undefined,
		getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }),
	};

	it("answers directly when the model calls no tool", async () => {
		const complete: CompleteSimple = async () => ({
			content: [{ type: "text", text: "no suspicion found" }],
			usage: ZERO_USAGE,
			stopReason: "end",
		});

		const result = await runInvestigation(
			registry,
			{ systemPrompt: "s", messages: [], tools: [], maxSteps: 3 },
			complete,
		);

		expect(result.ok).toBe(true);
		expect(result.text).toBe("no suspicion found");
		expect(result.steps).toBe(1);
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
				usage: ZERO_USAGE,
				stopReason: "end",
			};
		};

		await runInvestigation(
			suppressing,
			{ systemPrompt: "s", messages: [], tools: [], maxSteps: 1 },
			complete,
		);

		expect(sent).toEqual({ "x-kept": "v", "x-default": null });
	});

	it("runs a tool call, feeds the result back, and answers on the next step", async () => {
		let step = 0;
		const complete: CompleteSimple = async (_model, context) => {
			step += 1;
			if (step === 1) {
				return {
					// The compat surface's tool-call shape is typed narrowly
					// upstream (content only declares type/text) and cast
					// through unknown at the call site, same as production.
					content: [
						{
							type: "toolCall",
							id: "1",
							name: "grep",
							arguments: { pattern: "TODO" },
						},
					] as unknown as Array<{ type: string; text?: string }>,
					usage: ZERO_USAGE,
					stopReason: "tool_calls",
				};
			}
			const seenToolResult = (
				context as unknown as { messages: Array<{ role?: string }> }
			).messages.some((m) => m.role === "toolResult");
			expect(seenToolResult).toBe(true);
			return {
				content: [{ type: "text", text: "found one TODO" }],
				usage: ZERO_USAGE,
				stopReason: "end",
			};
		};

		const result = await runInvestigation(
			registry,
			{
				systemPrompt: "s",
				messages: [],
				tools: [
					{
						name: "grep",
						description: "search",
						parameters: {},
						execute: async (args) => `matched: ${args.pattern}`,
					},
				],
				maxSteps: 3,
			},
			complete,
		);

		expect(result.ok).toBe(true);
		expect(result.text).toBe("found one TODO");
		expect(result.steps).toBe(2);
	});

	it("reports the step budget exhausted when the model keeps calling tools", async () => {
		const complete: CompleteSimple = async () => ({
			content: [
				{ type: "toolCall", id: "1", name: "grep", arguments: {} },
			] as unknown as Array<{ type: string; text?: string }>,
			usage: ZERO_USAGE,
			stopReason: "tool_calls",
		});

		const result = await runInvestigation(
			registry,
			{
				systemPrompt: "s",
				messages: [],
				tools: [
					{
						name: "grep",
						description: "search",
						parameters: {},
						execute: async () => "no matches",
					},
				],
				maxSteps: 2,
			},
			complete,
		);

		expect(result.ok).toBe(true);
		expect(result.error).toBe("step budget exhausted");
		expect(result.steps).toBe(2);
	});
});
