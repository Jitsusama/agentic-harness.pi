/** Editor backend registrations belong to the caller; plain pi keeps its symbol. */

import type { LspBackendEntry } from "../../lsp/types.ts";
import { type SessionRef, sessionSlot } from "../../session/index.ts";

const SLOT = "pi:agentic-harness:lsp-backends";

function entries(ref?: SessionRef): Map<string, LspBackendEntry> {
	return sessionSlot(SLOT, ref, () => new Map<string, LspBackendEntry>());
}

/** Register a backend for this conversation, or the legacy pi process. */
export function register(entry: LspBackendEntry, ref?: SessionRef): void {
	entries(ref).set(entry.name, entry);
}

/** Remove one backend without touching another conversation's registrations. */
export function unregister(name: string, ref?: SessionRef): void {
	entries(ref).delete(name);
}

/** Empty this caller's registrations, without disposing externally owned servers. */
export function clear(ref?: SessionRef): void {
	entries(ref).clear();
}

/** Snapshot the caller's registered backends. */
export function list(ref?: SessionRef): LspBackendEntry[] {
	return [...entries(ref).values()];
}
