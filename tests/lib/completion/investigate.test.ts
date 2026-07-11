import { describe, expect, it } from "vitest";
import { runInvestigation } from "../../../lib/completion/investigate.js";
import type { CompletionRegistry } from "../../../lib/completion/types.js";

const glm = { id: "glm-5.2", provider: "fireworks" };

// The loop body dynamically imports the pi-ai compat module and would
// drive a real model, so — like the runSideCompletion suite — these
// cover the failure paths that resolve before the loop starts.
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

		const result = await runInvestigation(registry, request);

		expect(result.ok).toBe(false);
		expect(result.error).toContain("no model");
	});

	it("surfaces an auth-not-configured failure with the model named", async () => {
		const registry: CompletionRegistry = {
			getAvailable: () => [glm],
			find: () => undefined,
			getApiKeyAndHeaders: async () => ({ ok: false, error: "no key" }),
		};

		const result = await runInvestigation(registry, request);

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

		const result = await runInvestigation(registry, request);

		expect(result.ok).toBe(false);
		expect(result.error).toContain("auth resolution threw");
		expect(result.error).toContain("boom");
	});
});
