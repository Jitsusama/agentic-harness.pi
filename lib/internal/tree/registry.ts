/**
 * Tree provider registry: process-global map from provider
 * id to `TreeProvider`. Mirrors the refs, people and
 * terminal libraries; uses the same `globalThis` symbol
 * slot pattern.
 */

import type { TreeProvider } from "../../tree/types.js";

const REGISTRY_KEY = Symbol.for("pi:tree-providers");

type Registry = Map<string, TreeProvider>;
type GlobalRegistry = Record<symbol, Registry | undefined>;

function getRegistry(): Registry {
	const slot = globalThis as GlobalRegistry;
	const existing = slot[REGISTRY_KEY];
	if (existing) return existing;
	const fresh: Registry = new Map();
	slot[REGISTRY_KEY] = fresh;
	return fresh;
}

export function register(provider: TreeProvider): void {
	getRegistry().set(provider.id, provider);
}

export function unregister(id: string): void {
	getRegistry().delete(id);
}

export function clear(): void {
	getRegistry().clear();
}

export function get(id: string): TreeProvider | undefined {
	return getRegistry().get(id);
}

export function list(): TreeProvider[] {
	return [...getRegistry().values()];
}
