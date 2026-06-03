/**
 * Handle-type registry: a process-global map from handle
 * type identifier to `HandleType` definition.
 *
 * Same shape as the refs registry, separate global slot.
 * Stored on `globalThis` via `Symbol.for` so multiple
 * extension packages share one registry. Tests use `clear`
 * to isolate.
 */

import type { HandleType } from "../../people/types.js";

const REGISTRY_KEY = Symbol.for("pi:people-handle-types");

type Registry = Map<string, HandleType>;
type GlobalRegistry = Record<symbol, Registry | undefined>;

function getRegistry(): Registry {
	const slot = globalThis as GlobalRegistry;
	const existing = slot[REGISTRY_KEY];
	if (existing) return existing;
	const fresh: Registry = new Map();
	slot[REGISTRY_KEY] = fresh;
	return fresh;
}

export function register(handleType: HandleType): void {
	getRegistry().set(handleType.type, handleType);
}

export function unregister(type: string): void {
	getRegistry().delete(type);
}

export function clear(): void {
	getRegistry().clear();
}

export function get(type: string): HandleType | undefined {
	return getRegistry().get(type);
}

export function list(): HandleType[] {
	return [...getRegistry().values()];
}
