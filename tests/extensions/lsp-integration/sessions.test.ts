/** Two runners share servers but resolve their own relative edits and paths. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	clearLspBackends,
	type StandaloneBackend,
} from "../../../lib/core/lsp/index.ts";
import { extensionRunner } from "../../support/extension-runner.ts";

const started: StandaloneBackend[] = [];
vi.mock("../../../lib/core/lsp/index.ts", async (original) => ({
	...(await original<object>()),
	createStandaloneBackend() {
		const documents = new Map<string, string>();
		const backend: StandaloneBackend = {
			name: "standalone",
			diagnostics: vi.fn(async (path) =>
				documents.has(path)
					? [
							{
								path,
								message: documents.get(path) ?? "",
								severity: "error" as const,
								range: {
									start: { line: 1, character: 0 },
									end: { line: 1, character: 1 },
								},
							},
						]
					: [],
			),
			definition: async () => [],
			references: async () => [],
			hover: async () => null,
			documentSymbols: async () => [],
			workspaceSymbols: async () => [],
			rename: async () => ({ changes: [] }),
			codeActions: async () => [],
			syncDocument: (path, text) => {
				documents.set(path, text);
			},
			serverCount: () => 0,
			dispose: vi.fn(async () => {}),
		};
		started.push(backend);
		return backend;
	},
}));
const { default: lspIntegration } = await import(
	"../../../extensions/lsp-integration/index.ts"
);
const roots: string[] = [];
const runners: ReturnType<typeof extensionRunner>[] = [];
afterEach(async () => {
	for (const runner of runners.splice(0)) await runner.stop();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
	started.length = 0;
	clearLspBackends();
});

function session() {
	const root = mkdtempSync(join(tmpdir(), "lsp-session-"));
	roots.push(root);
	const session = extensionRunner(lspIntegration, root);
	runners.push(session);
	return { ...session, root };
}

describe("LSP in a process with two runners", () => {
	it("limits symbols to the caller's folder, not its similarly named sibling", async () => {
		const a = session();
		const b = session();
		await a.start();
		await b.start();
		const backend = started[0];
		if (!backend) throw new Error("no backend started");
		const symbol = (path: string) => ({
			name: "thing",
			kind: "variable",
			location: {
				path,
				range: {
					start: { line: 1, character: 0 },
					end: { line: 1, character: 1 },
				},
			},
		});
		backend.workspaceSymbols = vi.fn(async () => [
			symbol(join(a.root, "a.ts")),
			symbol(join(b.root, "b.ts")),
			symbol(join(`${a.root}-sibling`, "a.ts")),
		]);
		expect(
			await a.call("lsp", { operation: "workspace_symbols", query: "thing" }),
		).toMatchObject({ details: { count: 1 } });
		expect(
			await b.call("lsp", { operation: "workspace_symbols", query: "thing" }),
		).toMatchObject({ details: { count: 1 } });
	});
	it("replaces a dead backend once when two callers encounter its closed connection", async () => {
		const a = session();
		const b = session();
		await a.start();
		await b.start();
		const backend = started[0];
		if (!backend) throw new Error("no backend started");
		vi.mocked(backend.diagnostics).mockRejectedValue(
			new Error("Connection is closed."),
		);
		await Promise.all([
			a.call("lsp", { operation: "diagnostics", path: "a.ts" }),
			b.call("lsp", { operation: "diagnostics", path: "b.ts" }),
		]);
		expect(started).toHaveLength(2);
		expect(backend.dispose).toHaveBeenCalledOnce();
		await b.stop();
		expect(started[1]?.dispose).not.toHaveBeenCalled();
		expect(
			await a.call("lsp", { operation: "diagnostics", path: "a.ts" }),
		).toMatchObject({ details: { ok: true } });
	});

	it("shares edit sync, keeps A working after B quits, and closes only after A", async () => {
		const a = session();
		const b = session();
		await a.start();
		await b.start();
		await a.start();
		expect(started).toHaveLength(1);
		writeFileSync(join(a.root, "a.ts"), "new bytes");
		await a.runner.emitToolResult({
			type: "tool_result",
			toolCallId: "edit",
			toolName: "edit",
			input: { path: "a.ts" },
			content: [],
			details: undefined,
			isError: false,
		});
		expect(
			await b.call("lsp", {
				operation: "diagnostics",
				path: join(a.root, "a.ts"),
			}),
		).toMatchObject({ details: { count: 1 } });
		await b.stop();
		expect(started[0]?.dispose).not.toHaveBeenCalled();
		expect(
			await a.call("lsp", { operation: "diagnostics", path: "a.ts" }),
		).toMatchObject({ details: { count: 1 } });
		expect(started[0]?.diagnostics).toHaveBeenLastCalledWith(
			join(a.root, "a.ts"),
			expect.anything(),
		);
		await a.stop();
		expect(started[0]?.dispose).toHaveBeenCalledOnce();
		expect(a.errors).toEqual([]);
		expect(b.errors).toEqual([]);
	});
});
