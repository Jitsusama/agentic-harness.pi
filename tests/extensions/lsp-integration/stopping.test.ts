import {
	clearLspBackends,
	type LspBackend,
	registerLspBackend,
} from "@jitsusama/agentic-harness.core/lsp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import lspIntegration from "../../../extensions/lsp-integration/index.ts";
import { LSP_CALL_WALL_MS } from "../../../extensions/lsp-integration/limits.ts";

/**
 * What the lsp tool does when its language server will not answer.
 *
 * The backend behind the tool may be the standalone one, which bounds
 * itself, or one a paired editor registered, which may not. So the tool
 * hands every backend the call's signal and holds the call to a clock of
 * its own, rather than trusting whichever backend is active to end.
 */

interface Tool {
	execute(
		id: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<{ content: { type: string; text: string }[] }>;
}

/** Longer than a call given up on should take to end. */
const STILL_RUNNING_MS = 2000;

/** The call's outcome, or a note that it was still waiting. */
async function outcome(call: Promise<unknown>): Promise<string> {
	const running = new Promise<string>((resolve) =>
		setTimeout(() => resolve("still running"), STILL_RUNNING_MS),
	);
	return Promise.race([
		call.then(
			(result) => {
				const text = (result as { content: { text: string }[] }).content[0]
					?.text;
				return `answered: ${text}`;
			},
			(error: unknown) =>
				error instanceof Error ? `failed: ${error.name}` : "failed",
		),
		running,
	]);
}

/** The lsp tool, as the extension registered it. */
function lspTool(): Tool {
	let found: Tool | undefined;
	const pi = {
		registerTool(definition: Tool) {
			found = definition;
		},
		on() {},
		events: { on() {}, emit() {} },
	};
	lspIntegration(pi as never);
	if (!found) throw new Error("the lsp tool was not registered");
	return found;
}

/** A backend that never answers, keeping each signal it was handed. */
function silentBackend(handed: Array<AbortSignal | undefined>): LspBackend {
	const never = (options?: { signal?: AbortSignal }): Promise<never> => {
		handed.push(options?.signal);
		return new Promise(() => {});
	};
	return {
		name: "silent",
		diagnostics: (_path, options) => never(options),
		definition: (_target, options) => never(options),
		references: (_target, options) => never(options),
		hover: (_target, options) => never(options),
		documentSymbols: (_path, options) => never(options),
		workspaceSymbols: (_query, options) => never(options),
		rename: (_target, _name, options) => never(options),
		codeActions: (_path, _range, options) => never(options),
		dispose: async () => {},
	};
}

const at = { path: "/work/a.ts", line: 1, character: 0 };
const OPERATIONS: ReadonlyArray<[string, Record<string, unknown>]> = [
	["diagnostics", { path: at.path }],
	["definition", at],
	["references", at],
	["hover", at],
	["document_symbols", { path: at.path }],
	["workspace_symbols", { query: "thing" }],
	["rename", { ...at, newName: "other" }],
	["code_actions", { path: at.path }],
];

describe("an lsp call whose server never answers", () => {
	let handed: Array<AbortSignal | undefined>;

	beforeEach(() => {
		handed = [];
		clearLspBackends();
		registerLspBackend({
			name: "silent",
			priority: 1,
			isAvailable: () => true,
			backend: silentBackend(handed),
		});
	});

	afterEach(() => {
		vi.useRealTimers();
		clearLspBackends();
	});

	it.each(
		OPERATIONS,
	)("ends when its caller stops a %s, and tells the backend", async (operation, params) => {
		const controller = new AbortController();
		const call = lspTool().execute(
			"call",
			{ operation, ...params },
			controller.signal,
		);
		setTimeout(() => controller.abort(), 50);
		expect(await outcome(call)).toBe("failed: AbortError");
		expect(handed).toHaveLength(1);
		expect(handed[0]?.aborted).toBe(true);
	});

	it.each(
		OPERATIONS,
	)("gives up on a %s at its clock, says so, and tells the backend", async (operation, params) => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const call = lspTool().execute("call", { operation, ...params });
		// Handled now, so a rejection while the clock is wound on is not
		// reported as unhandled before outcome listens.
		const watched = call.then((result) => result);
		watched.catch(() => {});
		await vi.advanceTimersByTimeAsync(LSP_CALL_WALL_MS);
		vi.useRealTimers();
		expect(await outcome(watched)).toMatch(/^answered: .*given up on/);
		expect(handed[0]?.aborted).toBe(true);
	});
});
