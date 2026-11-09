/** Workspace searches and edit sync stay inside the caller's project roots. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
	createStandaloneBackend,
	type StandaloneBackend,
} from "../../../../lib/core/lsp/index.ts";

const live = vi.hoisted(
	() =>
		new Map<
			string,
			{ search: ReturnType<typeof vi.fn>; sync: ReturnType<typeof vi.fn> }
		>(),
);
vi.mock("../../../../lib/core/lsp/standalone/server.ts", () => ({
	StandaloneServer: {
		async start(_config: unknown, root: string) {
			const search = vi.fn(async () => [
				{
					name: "thing",
					kind: "variable",
					location: {
						path: join(root, "one.ts"),
						range: {
							start: { line: 1, character: 0 },
							end: { line: 1, character: 1 },
						},
					},
				},
			]);
			const sync = vi.fn();
			live.set(root, { search, sync });
			return {
				root,
				onGone() {},
				diagnose: async () => [],
				workspaceSymbols: search,
				syncDocument: sync,
				dispose: async () => {},
			};
		},
	},
}));
let dir: string | undefined;
let backend: StandaloneBackend | undefined;
afterEach(async () => {
	await backend?.dispose();
	if (dir) rmSync(dir, { recursive: true, force: true });
	live.clear();
});

it("does not ask another root's server and does not sync a sibling sharing its prefix", async () => {
	dir = mkdtempSync(join(tmpdir(), "lsp-scope-"));
	const a = join(dir, "a");
	const b = join(dir, "a-sibling");
	for (const root of [a, b]) {
		mkdirSync(root);
		writeFileSync(join(root, "marker"), "");
		writeFileSync(join(root, "one.ts"), "");
	}
	backend = createStandaloneBackend({
		servers: {
			fake: {
				name: "fake",
				command: process.execPath,
				args: [],
				fileTypes: [".ts"],
				rootMarkers: ["marker"],
			},
		},
	});
	await backend.diagnostics(join(a, "one.ts"));
	await backend.diagnostics(join(b, "one.ts"));
	expect(await backend.workspaceSymbols("thing", { root: a })).toHaveLength(1);
	expect(live.get(a)?.search).toHaveBeenCalledOnce();
	expect(live.get(b)?.search).not.toHaveBeenCalled();
	backend.syncDocument(join(b, "one.ts"), "new bytes");
	await Promise.resolve();
	expect(live.get(a)?.sync).not.toHaveBeenCalled();
	expect(live.get(b)?.sync).toHaveBeenCalledWith(
		join(b, "one.ts"),
		"new bytes",
	);
	expect(await backend.workspaceSymbols("thing")).toHaveLength(2);
});
