/** Reload-safe session slots, preserving legacy process symbols on plain pi. */
import { processGlobal } from "../../internal/process-global.ts";
import { hosted } from "./host.ts";
import { requireSession, type SessionRef } from "./identity.ts";

const SLOTS_KEY = "agentic-harness.session.slots.v2";

function slots(): Map<string, Map<string, unknown>> {
	return processGlobal(SLOTS_KEY, () => new Map());
}

/** Same symbol on pi; isolated by session and slot name when hosted. */
export function sessionSlot<T>(
	name: string,
	ref: SessionRef | undefined,
	create: () => T,
): T {
	if (!hosted()) return processGlobal(name, create);
	const key = requireSession(ref);
	const all = slots();
	let session = all.get(key);
	if (!session) {
		session = new Map();
		all.set(key, session);
	}
	if (!session.has(name)) session.set(name, create());
	// The slot name is the caller's type contract, just as for processGlobal.
	return session.get(name) as T;
}

/** Free a closed conversation's slots, never on reload or on plain pi. */
export function releaseSession(sessionId: string): void {
	if (hosted()) slots().delete(sessionId);
}
