/**
 * Tree provider registration.
 *
 * Process-global and keyed by id, so a provider in another package
 * registers itself and is used, whichever order the two happened to
 * load in. Mirrors the review and tree registries and uses the same
 * shared globalThis-slot helper, so a module reimport does not lose
 * registrations.
 *
 * Listing sorts by specificity rather than registration order,
 * because the order providers are consulted in is part of the
 * contract and no caller should have to re-sort to get it right.
 */

import { createGlobalSymbolRegistry } from "../internal/registry/global-symbol-registry.js";
import type { TreeProvider } from "./broker.js";

const registry = createGlobalSymbolRegistry<TreeProvider>({
	slot: "pi:agentic-harness:work-tree-providers",
	getId: (provider) => provider.id,
});

/**
 * Register a tree provider, replacing any provider already
 * registered under the same id.
 *
 * Replacing rather than adding matters: a provider re-registers
 * after a reload, and the host announces itself again, so
 * registering twice is the ordinary case rather than a mistake.
 */
export function registerTreeProvider(provider: TreeProvider): void {
	registry.register(provider);
}

/** Remove a provider from the registry. Idempotent. */
export function unregisterTreeProvider(id: string): void {
	registry.unregister(id);
}

/** Every registered provider, most specific first. */
export function listTreeProviders(): TreeProvider[] {
	return [...registry.list()].sort((a, b) => b.specificity - a.specificity);
}

/** Empty the registry. Intended for tests. */
export function clearTreeProviders(): void {
	registry.clear();
}
