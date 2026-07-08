import { afterEach, describe, expect, it } from "vitest";
import {
	clearLspBackends,
	listLspBackends,
	registerLspBackend,
	resolveLspBackend,
	unregisterLspBackend,
} from "../../../lib/lsp/registry.js";
import type { LspBackend } from "../../../lib/lsp/types.js";

function fakeBackend(name: string): LspBackend {
	return {
		name,
		diagnostics: async () => [],
		definition: async () => [],
		references: async () => [],
		hover: async () => null,
		documentSymbols: async () => [],
		workspaceSymbols: async () => [],
		rename: async () => ({ changes: [] }),
		codeActions: async () => [],
		dispose: async () => {},
	};
}

afterEach(() => clearLspBackends());

describe("resolveLspBackend", () => {
	it("returns undefined when nothing is registered", () => {
		expect(resolveLspBackend()).toBeUndefined();
	});

	it("picks the available backend with the lowest priority number", () => {
		registerLspBackend({
			name: "standalone",
			priority: 100,
			isAvailable: () => true,
			backend: fakeBackend("standalone"),
		});
		registerLspBackend({
			name: "neovim",
			priority: 10,
			isAvailable: () => true,
			backend: fakeBackend("neovim"),
		});
		expect(resolveLspBackend()?.name).toBe("neovim");
	});

	it("skips a lower-priority backend that is unavailable", () => {
		registerLspBackend({
			name: "standalone",
			priority: 100,
			isAvailable: () => true,
			backend: fakeBackend("standalone"),
		});
		registerLspBackend({
			name: "neovim",
			priority: 10,
			isAvailable: () => false,
			backend: fakeBackend("neovim"),
		});
		expect(resolveLspBackend()?.name).toBe("standalone");
	});

	it("forgets a backend after it is unregistered", () => {
		registerLspBackend({
			name: "standalone",
			priority: 100,
			isAvailable: () => true,
			backend: fakeBackend("standalone"),
		});
		unregisterLspBackend("standalone");
		expect(listLspBackends()).toEqual([]);
		expect(resolveLspBackend()).toBeUndefined();
	});
});
