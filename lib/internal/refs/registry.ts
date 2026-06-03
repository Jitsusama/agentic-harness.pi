/**
 * Refs registry: a process-global map from ref type
 * identifier to `RefType` definition.
 *
 * Stored on `globalThis` via `Symbol.for` so multiple
 * extension packages share a single registry. The quest
 * extension registers the built-in types; downstream
 * packages can register their own without coordinating.
 *
 * State is per-process and resets on `/reload` or restart.
 * Tests use `clear()` to isolate one test from the next.
 */

import type { Ref, RefType } from "../../refs/types.js";

const REGISTRY_KEY = Symbol.for("pi:refs-registry");

type Registry = Map<string, RefType>;
type GlobalRegistry = Record<symbol, Registry | undefined>;

function getRegistry(): Registry {
	const slot = globalThis as GlobalRegistry;
	const existing = slot[REGISTRY_KEY];
	if (existing) return existing;
	const fresh: Registry = new Map();
	slot[REGISTRY_KEY] = fresh;
	return fresh;
}

export function register(refType: RefType): void {
	getRegistry().set(refType.type, refType);
}

export function unregister(type: string): void {
	getRegistry().delete(type);
}

export function clear(): void {
	getRegistry().clear();
}

export function get(type: string): RefType | undefined {
	return getRegistry().get(type);
}

export function list(): RefType[] {
	return [...getRegistry().values()];
}

/**
 * Run every registered type's `matchAll` against the given
 * text and return the union of matches. Order: ref types
 * are visited in registration order; matches within a type
 * follow that type's own order. Duplicate `{type, value}`
 * pairs are dropped.
 */
export function parseAll(text: string): Ref[] {
	const refs: Ref[] = [];
	const seen = new Set<string>();
	for (const rt of list()) {
		for (const value of rt.matchAll(text)) {
			const key = `${rt.type}|${value}`;
			if (seen.has(key)) continue;
			seen.add(key);
			refs.push({ type: rt.type, value });
		}
	}
	return refs;
}
