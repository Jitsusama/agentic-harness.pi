/**
 * Backend registration and resolution. Mirrors the tree and
 * terminal libraries: explicit registration, a resolve that
 * ranks by priority, and an opt-out clear for tests.
 *
 * Resolution picks the available backend with the lowest
 * priority number. The standalone backend registers at 100;
 * a downstream editor-forwarding backend registers below that
 * and reports itself available only under its own precondition,
 * so it takes over transparently when present.
 */

import { clear, list, register, unregister } from "../internal/lsp/registry.ts";
import type { SessionRef } from "../session/index.ts";
import type { LspBackend, LspBackendEntry } from "./types.ts";

/** Register or overwrite an entry for the caller; plain pi keeps its process registry. */
export function registerLspBackend(
	entry: LspBackendEntry,
	ref?: SessionRef,
): void {
	register(entry, ref);
}

/** Remove a caller's backend by name. Idempotent. */
export function unregisterLspBackend(name: string, ref?: SessionRef): void {
	unregister(name, ref);
}

/** Snapshot of this caller's registered backend entries. */
export function listLspBackends(ref?: SessionRef): LspBackendEntry[] {
	return list(ref);
}

/**
 * Resolve the active backend: the available entry with the
 * lowest priority number, or undefined when none is
 * available. Explicit caller identity outranks the host's ambient session;
 * plain pi retains its shared process registry.
 */
export function resolveLspBackend(ref?: SessionRef): LspBackend | undefined {
	const ranked = [...list(ref)].sort((a, b) => a.priority - b.priority);
	for (const entry of ranked) {
		if (entry.isAvailable()) return entry.backend;
	}
	return undefined;
}

/** Empty this caller's registry without disposing its backends. */
export function clearLspBackends(ref?: SessionRef): void {
	clear(ref);
}
