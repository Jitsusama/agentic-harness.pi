/**
 * Backend registration and resolution. Mirrors the tree and
 * terminal libraries: explicit registration, a resolve that
 * ranks by priority, and an opt-out clear for tests.
 *
 * Resolution picks the available backend with the lowest
 * priority number. The standalone backend registers at 100;
 * neovim.pi registers its backend below that and reports
 * itself available only while a session is paired, so it
 * takes over transparently when present.
 */

import {
	clear,
	get,
	list,
	register,
	unregister,
} from "../internal/lsp/registry.js";
import type { LspBackend, LspBackendEntry } from "./types.js";

/** Register or overwrite a backend entry. */
export function registerLspBackend(entry: LspBackendEntry): void {
	register(entry);
}

/** Remove a backend by name. Idempotent. */
export function unregisterLspBackend(name: string): void {
	unregister(name);
}

/** Look up a backend entry by name. */
export function getLspBackend(name: string): LspBackendEntry | undefined {
	return get(name);
}

/** Snapshot of every registered backend entry. */
export function listLspBackends(): LspBackendEntry[] {
	return list();
}

/**
 * Resolve the active backend: the available entry with the
 * lowest priority number, or undefined when none is
 * available.
 */
export function resolveLspBackend(): LspBackend | undefined {
	const ranked = [...list()].sort((a, b) => a.priority - b.priority);
	for (const entry of ranked) {
		if (entry.isAvailable()) return entry.backend;
	}
	return undefined;
}

/** Empty the registry. Intended for tests. */
export function clearLspBackends(): void {
	clear();
}
