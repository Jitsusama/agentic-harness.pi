/**
 * Refs registry: a process-global map from ref type
 * identifier to `RefType` definition.
 *
 * Implementation note: backed by the shared
 * `createGlobalSymbolRegistry` helper so every package
 * registry follows the same shape. The slot persists
 * across module reimport but NOT across pi's `/reload`,
 * which spawns a fresh process. Tests call `clear()` to
 * isolate registrations between cases.
 */

import type { Ref, RefType } from "../../refs/types.js";
import { createGlobalSymbolRegistry } from "../registry/global-symbol-registry.js";

const registry = createGlobalSymbolRegistry<RefType>({
	slot: "pi:agentic-harness:refs-registry",
	getId: (rt) => rt.type,
});

export const register = (refType: RefType): void => registry.register(refType);
export const unregister = (type: string): void => registry.unregister(type);
export const clear = (): void => registry.clear();
export const get = (type: string): RefType | undefined => registry.get(type);
export const list = (): RefType[] => registry.list();

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
