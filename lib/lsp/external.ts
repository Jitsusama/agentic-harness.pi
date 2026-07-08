/**
 * Validation for LSP backends registered from another pi package.
 *
 * Pi loads packages with isolated module roots, so a paired editor
 * integration (neovim.pi) cannot import the registry to add its backend.
 * It emits the entry on the shared event bus instead, and the
 * lsp-integration extension validates and registers it here. The payload
 * crosses a trust boundary from a third-party emitter, so a malformed
 * entry is rejected rather than trusted.
 */

import type { LspBackend, LspBackendEntry } from "./types.js";

/** Method names every backend must provide as functions. */
const BACKEND_METHODS: ReadonlyArray<keyof LspBackend> = [
	"diagnostics",
	"definition",
	"references",
	"hover",
	"documentSymbols",
	"workspaceSymbols",
	"rename",
	"codeActions",
	"dispose",
];

/** Whether every value in the object is a function under the given keys. */
function hasFunctions(
	value: Record<string, unknown>,
	keys: ReadonlyArray<string>,
): boolean {
	return keys.every((key) => typeof value[key] === "function");
}

/**
 * Validate an event payload as a backend entry, or return null when it
 * does not structurally satisfy the contract. Checks the entry fields
 * and that the backend carries every operation as a function plus a
 * string name.
 */
export function toBackendEntry(data: unknown): LspBackendEntry | null {
	if (typeof data !== "object" || data === null) return null;
	const record = data as Record<string, unknown>;

	if (typeof record.name !== "string" || record.name.length === 0) return null;
	if (typeof record.priority !== "number") return null;
	if (typeof record.isAvailable !== "function") return null;

	const backend = record.backend;
	if (typeof backend !== "object" || backend === null) return null;
	const backendRecord = backend as Record<string, unknown>;
	if (typeof backendRecord.name !== "string") return null;
	if (!hasFunctions(backendRecord, BACKEND_METHODS)) return null;

	return {
		name: record.name,
		priority: record.priority,
		isAvailable: record.isAvailable as () => boolean,
		backend: backend as LspBackend,
	};
}
