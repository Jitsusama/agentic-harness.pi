/**
 * Person-resolver registry: process-global ordered list
 * of `PersonResolver`s. Mirrors the refs and people
 * handle-type registries; uses the same `globalThis`
 * symbol slot pattern.
 *
 * Order is by `priority` ascending (lower runs first), with
 * registration order as a tiebreaker. Built-ins ship at
 * priority 100; downstream resolvers register at lower
 * priorities to take precedence.
 */

import type {
	Identity,
	PersonResolver,
	ResolutionFallback,
	ResolveOptions,
} from "../../people/types.js";

const REGISTRY_KEY = Symbol.for("pi:person-resolvers");

interface Slot {
	resolvers: PersonResolver[];
	fallback: ResolutionFallback;
}

type GlobalSlot = Record<symbol, Slot | ResolutionFallback | undefined>;

function getSlot(): Slot {
	const g = globalThis as GlobalSlot;
	const existing = g[REGISTRY_KEY];
	if (existing && typeof existing === "object") return existing as Slot;
	const fresh: Slot = { resolvers: [], fallback: "warn" };
	(g as GlobalSlot)[REGISTRY_KEY] = fresh;
	return fresh;
}

function priority(resolver: PersonResolver): number {
	return resolver.priority ?? 100;
}

export function register(resolver: PersonResolver): void {
	const slot = getSlot();
	const existing = slot.resolvers.findIndex((r) => r.id === resolver.id);
	if (existing >= 0) slot.resolvers.splice(existing, 1);
	slot.resolvers.push(resolver);
	// Stable sort: priority ascending, registration order otherwise.
	slot.resolvers.sort((a, b) => priority(a) - priority(b));
}

export function unregister(id: string): void {
	const slot = getSlot();
	const i = slot.resolvers.findIndex((r) => r.id === id);
	if (i >= 0) slot.resolvers.splice(i, 1);
}

export function clear(): void {
	getSlot().resolvers = [];
}

export function get(id: string): PersonResolver | undefined {
	return getSlot().resolvers.find((r) => r.id === id);
}

export function list(): PersonResolver[] {
	return [...getSlot().resolvers];
}

export function setFallback(behaviour: ResolutionFallback): void {
	getSlot().fallback = behaviour;
}

export function getFallback(): ResolutionFallback {
	return getSlot().fallback;
}

/**
 * Walk the chain and return the first identity any resolver
 * supplies. Errors from resolvers collapse to `undefined`
 * and the chain continues.
 */
export async function resolveChain(
	input: string,
	opts?: ResolveOptions,
): Promise<{ identity: Identity; via: string } | undefined> {
	for (const resolver of getSlot().resolvers) {
		try {
			const identity = await resolver.resolve(input, opts);
			if (identity) return { identity, via: resolver.id };
		} catch {
			// Swallow integration failures; the chain continues.
		}
	}
	return undefined;
}
