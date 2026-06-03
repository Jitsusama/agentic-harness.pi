/**
 * Person-resolver public surface: register, list, and walk
 * the chain to resolve an input string against external
 * systems.
 *
 * Built-ins ship at priority 100; downstream packages
 * register their own resolvers at lower priorities to take
 * precedence (e.g. a Vault lookup at priority 50).
 */

import { slackResolver } from "../internal/people/resolvers/slack.js";
import {
	clear,
	get,
	getFallback,
	list,
	register,
	resolveChain,
	setFallback,
	unregister,
} from "../internal/people/resolvers.js";
import type {
	Identity,
	PersonResolver,
	ResolutionFallback,
	ResolveOptions,
} from "./types.js";

/** Register a person resolver. Overwrites by id. */
export function registerPersonResolver(resolver: PersonResolver): void {
	register(resolver);
}

/** Remove a resolver by id. Idempotent. */
export function unregisterPersonResolver(id: string): void {
	unregister(id);
}

/** Empty the resolver list. Tests only. */
export function clearPersonResolvers(): void {
	clear();
}

/** Look up a resolver by id, or undefined. */
export function getPersonResolver(id: string): PersonResolver | undefined {
	return get(id);
}

/** Snapshot of every registered resolver in priority order. */
export function listPersonResolvers(): PersonResolver[] {
	return list();
}

/**
 * Seed the registry with the built-in `slack` resolver.
 * Idempotent. Downstream packages call this on activate
 * alongside their own `registerPersonResolver` calls so the
 * built-in is always present.
 */
export function registerBuiltinPersonResolvers(): void {
	register(slackResolver);
}

/** Set the fallback behaviour when no resolver answers. */
export function setResolutionFallback(behaviour: ResolutionFallback): void {
	setFallback(behaviour);
}

/** Current fallback behaviour. Defaults to `warn`. */
export function getResolutionFallback(): ResolutionFallback {
	return getFallback();
}

/**
 * Walk the resolver chain for one input string. Returns
 * the first identity any resolver supplies, plus the id of
 * the resolver that supplied it. Returns `undefined` when
 * no resolver has an answer.
 */
export async function resolveIdentity(
	input: string,
	opts?: ResolveOptions,
): Promise<{ identity: Identity; via: string } | undefined> {
	return resolveChain(input, opts);
}
