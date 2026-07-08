import { describe, expect, it } from "vitest";
import { toBackendEntry } from "../../../lib/lsp/external.js";

/** A structurally complete backend for the happy-path cases. */
function fullBackend(): Record<string, unknown> {
	const noop = () => Promise.resolve();
	return {
		name: "neovim",
		diagnostics: noop,
		definition: noop,
		references: noop,
		hover: noop,
		documentSymbols: noop,
		workspaceSymbols: noop,
		rename: noop,
		codeActions: noop,
		dispose: noop,
	};
}

function fullEntry(): Record<string, unknown> {
	return {
		name: "neovim",
		priority: 50,
		isAvailable: () => true,
		backend: fullBackend(),
	};
}

describe("toBackendEntry", () => {
	it("accepts a structurally complete entry", () => {
		const entry = toBackendEntry(fullEntry());
		expect(entry).not.toBeNull();
		expect(entry?.name).toBe("neovim");
		expect(entry?.priority).toBe(50);
		expect(entry?.isAvailable()).toBe(true);
	});

	it("rejects a non-object payload", () => {
		expect(toBackendEntry(null)).toBeNull();
		expect(toBackendEntry("neovim")).toBeNull();
		expect(toBackendEntry(42)).toBeNull();
	});

	it("rejects an entry missing name or priority", () => {
		const noName = fullEntry();
		delete noName.name;
		expect(toBackendEntry(noName)).toBeNull();

		const badPriority = fullEntry();
		badPriority.priority = "high";
		expect(toBackendEntry(badPriority)).toBeNull();
	});

	it("rejects an entry whose isAvailable is not a function", () => {
		const entry = fullEntry();
		entry.isAvailable = true;
		expect(toBackendEntry(entry)).toBeNull();
	});

	it("rejects a backend missing an operation", () => {
		const entry = fullEntry();
		const backend = fullBackend();
		delete backend.rename;
		entry.backend = backend;
		expect(toBackendEntry(entry)).toBeNull();
	});

	it("rejects a backend that is not an object or lacks a name", () => {
		const noBackend = fullEntry();
		noBackend.backend = null;
		expect(toBackendEntry(noBackend)).toBeNull();

		const unnamed = fullEntry();
		const backend = fullBackend();
		delete backend.name;
		unnamed.backend = backend;
		expect(toBackendEntry(unnamed)).toBeNull();
	});
});
