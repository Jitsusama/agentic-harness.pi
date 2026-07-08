/**
 * Mutable LSP backend registry. Mirrors the tree and
 * terminal registries: a process-global map keyed by backend
 * name, with register, unregister, get, list and clear.
 * Public wrappers live in `lib/lsp`.
 */

import type { LspBackendEntry } from "../../lsp/types.js";
import { processGlobal } from "../process-global.js";

// Process-global so a backend registered by lsp-integration is
// seen by verification-workflow and any other extension that
// resolves it; a module-level Map would give each extension its
// own, empty registry.
const registry = processGlobal(
	"pi:lsp-backends",
	() => new Map<string, LspBackendEntry>(),
);

/** Register or overwrite a backend entry by name. */
export function register(entry: LspBackendEntry): void {
	registry.set(entry.name, entry);
}

/** Remove a backend by name. Idempotent. */
export function unregister(name: string): void {
	registry.delete(name);
}

/** Look up a backend entry by name. */
export function get(name: string): LspBackendEntry | undefined {
	return registry.get(name);
}

/** Snapshot of every registered entry. */
export function list(): LspBackendEntry[] {
	return [...registry.values()];
}

/** Empty the registry. Intended for tests. */
export function clear(): void {
	registry.clear();
}
