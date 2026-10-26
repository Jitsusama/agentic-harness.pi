/**
 * Tree provider registry: process-global map from provider
 * id to `TreeProvider`. Mirrors the refs and terminal
 * libraries; uses the same shared `createGlobalSymbolRegistry`
 * helper.
 *
 * The slot is shared with other packages' pinned copies of the
 * harness, which register into it directly, so a provider written
 * before the glossary said release can be found here still saying
 * `prune`. Every read hands it out saying `release`.
 */

import { createGlobalSymbolRegistry } from "../../../internal/registry/global-symbol-registry.ts";
import type {
	TreeProvider,
	TreeProviderSayingPrune,
} from "../../tree/types.ts";

type Registered = TreeProvider | TreeProviderSayingPrune;

const registry = createGlobalSymbolRegistry<Registered>({
	slot: "pi:agentic-harness:tree-providers",
	getId: (p) => p.id,
});

/** A provider as callers use it, whichever name it was written with. */
function releasing(provider: Registered): TreeProvider {
	if ("release" in provider) return provider;
	const { list } = provider;
	return {
		id: provider.id,
		priority: provider.priority,
		appliesTo: (repoRoot) => provider.appliesTo(repoRoot),
		create: (input) => provider.create(input),
		release: (input) => provider.prune(input),
		...(list
			? { list: (repoRoot: string) => list.call(provider, repoRoot) }
			: {}),
	};
}

export const register = (provider: Registered): void =>
	registry.register(provider);
export const unregister = (id: string): void => registry.unregister(id);
export const clear = (): void => registry.clear();
export const get = (id: string): TreeProvider | undefined => {
	const provider = registry.get(id);
	return provider && releasing(provider);
};
export const list = (): TreeProvider[] => registry.list().map(releasing);
