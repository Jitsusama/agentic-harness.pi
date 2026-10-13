/**
 * What the lsp tool does when the standalone server behind it has died.
 *
 * The pool hands the same dead connection to every later call, so once
 * a server exited every call answered "Connection is closed." until the
 * session ended. The tool starts the standalone servers afresh and asks
 * once more; an editor's backend is left to its editor.
 */

import {
	clearLspBackends,
	type LspBackend,
	registerLspBackend,
} from "@jitsusama/agentic-harness.core/lsp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface Tool {
	execute(
		id: string,
		params: Record<string, unknown>,
	): Promise<{ content: { type: string; text: string }[] }>;
}

/** How each standalone backend the extension starts will answer. */
const scripts: Array<() => Promise<unknown[]>> = [];
const started: Array<{ disposed: boolean }> = [];

function backendAnswering(answer: () => Promise<unknown[]>): LspBackend {
	const record = { disposed: false };
	started.push(record);
	const nothing = async () => [];
	return {
		name: "standalone",
		diagnostics: () => answer() as never,
		definition: nothing,
		references: nothing,
		hover: async () => null,
		documentSymbols: nothing,
		workspaceSymbols: nothing,
		rename: async () => ({ changes: [] }),
		codeActions: nothing,
		dispose: async () => {
			record.disposed = true;
		},
	} as unknown as LspBackend;
}

vi.mock("@jitsusama/agentic-harness.core/lsp", async (original) => ({
	...(await original<object>()),
	createStandaloneBackend: () =>
		backendAnswering(scripts.shift() ?? (async () => [])),
}));

const { default: lspIntegration, closedConnection } = await import(
	"../../../extensions/lsp-integration/index.ts"
);

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

const closed = () => Promise.reject(new Error("Connection is closed."));

beforeEach(() => {
	clearLspBackends();
	scripts.length = 0;
	started.length = 0;
});

afterEach(() => {
	clearLspBackends();
});

describe("an lsp call whose standalone server has died", () => {
	it("starts the servers afresh and answers from the new ones", async () => {
		scripts.push(closed, async () => []);
		const answer = await lspTool().execute("c", {
			operation: "diagnostics",
			path: "/work/a.ts",
		});

		expect(answer.content[0]?.text).not.toMatch(/closed/i);
		expect(started).toHaveLength(2);
		expect(started[0]?.disposed).toBe(true);
	});

	it("asks only once more, and reports a second death as it came", async () => {
		scripts.push(closed, closed);
		await expect(
			lspTool().execute("c", { operation: "diagnostics", path: "/work/a.ts" }),
		).rejects.toThrow("Connection is closed.");
		expect(started).toHaveLength(2);
	});

	it("leaves an editor's backend to its editor", async () => {
		let asked = 0;
		registerLspBackend({
			name: "editor",
			priority: 1,
			isAvailable: () => true,
			backend: {
				...backendAnswering(async () => []),
				diagnostics: () => {
					asked += 1;
					return closed() as never;
				},
			} as LspBackend,
		});
		started.length = 0;
		await expect(
			lspTool().execute("c", { operation: "diagnostics", path: "/work/a.ts" }),
		).rejects.toThrow("Connection is closed.");
		expect(asked).toBe(1);
		expect(started).toHaveLength(0);
	});
});

describe("what counts as a server that has gone", () => {
	it.each([
		["Connection is closed.", true],
		["Connection is disposed.", true],
		["Pending response rejected since connection got disposed", true],
		["Connection refused", false],
		["Request textDocument/hover failed", false],
	])("%j is %s", (message, gone) => {
		expect(closedConnection(new Error(message))).toBe(gone);
	});
});
