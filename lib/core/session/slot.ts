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

/** A session's value that may be absent: set, read and taken away again. */
export interface SessionCell<T> {
	get(): T | undefined;
	set(value: T): void;
	clear(): void;
}

/**
 * A cell named `name` for the session `ref` names, or the ambient one. On
 * plain pi the value sits on `globalThis` under `Symbol.for(name)` itself,
 * absent when cleared, exactly as code that predates the cell keeps it, so
 * a reload between versions still finds what the last one left. Hosted,
 * each conversation has its own, which its close frees.
 */
export function sessionCell<T>(name: string, ref?: SessionRef): SessionCell<T> {
	if (!hosted()) {
		const symbol = Symbol.for(name);
		const store = globalThis as Record<symbol, T | undefined>;
		return {
			get: () => store[symbol],
			set: (value) => {
				store[symbol] = value;
			},
			clear: () => {
				delete store[symbol];
			},
		};
	}
	const key = requireSession(ref);
	const all = slots();
	return {
		// The cell name is the caller's type contract, as for sessionSlot.
		get: () => all.get(key)?.get(name) as T | undefined,
		set: (value) => {
			let session = all.get(key);
			if (!session) {
				session = new Map();
				all.set(key, session);
			}
			session.set(name, value);
		},
		clear: () => {
			all.get(key)?.delete(name);
		},
	};
}

/** Free a closed conversation's slots, never on reload or on plain pi. */
export function releaseSession(sessionId: string): void {
	if (hosted()) slots().delete(sessionId);
}
