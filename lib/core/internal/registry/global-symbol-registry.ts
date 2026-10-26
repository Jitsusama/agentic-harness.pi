/**
 * Shared helper for pluggable registries stashed on
 * `globalThis` under a `Symbol.for` key.
 *
 * Several library modules (refs, people handle types,
 * terminal drivers, tree providers, URL fetchers) ship the
 * same shape: a Map keyed by a stable id, behind a
 * symbol-keyed slot on globalThis so HMR-style reloads
 * don't lose registrations. Each used to inline the same
 * five-function quintet. This helper deduplicates the
 * mechanism so a new registry is a three-line wrapper.
 *
 * The slot persists across module reimport, NOT across pi's
 * own `/reload` (which spawns a new process and a fresh
 * globalThis). Callers that need to reseed built-ins on
 * activate should idempotently call their `registerBuiltin*`
 * helper.
 */

export interface RegistryHandle<T> {
	register(value: T): void;
	unregister(id: string): void;
	clear(): void;
	get(id: string): T | undefined;
	list(): T[];
}

/**
 * Create a registry backed by a globalThis slot keyed by
 * `Symbol.for(slot)`. The slot key should be unique across
 * the package (use a `pi:<package>:<kind>` shape so
 * registrations don't alias across libraries).
 *
 * `getId` extracts the stable id from a registered value.
 */
export function createGlobalSymbolRegistry<T>(options: {
	slot: string;
	getId: (value: T) => string;
}): RegistryHandle<T> {
	const key = Symbol.for(options.slot);
	type Slot = Record<symbol, Map<string, T> | undefined>;

	function entries(): Map<string, T> {
		const host = globalThis as Slot;
		const existing = host[key];
		if (existing) return existing;
		const fresh = new Map<string, T>();
		host[key] = fresh;
		return fresh;
	}

	return {
		register(value: T): void {
			entries().set(options.getId(value), value);
		},
		unregister(id: string): void {
			entries().delete(id);
		},
		clear(): void {
			entries().clear();
		},
		get(id: string): T | undefined {
			return entries().get(id);
		},
		list(): T[] {
			return [...entries().values()];
		},
	};
}
