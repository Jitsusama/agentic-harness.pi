/**
 * Review provider registry: process-global map from provider
 * id to `ReviewProvider`. Mirrors the tree, refs, people and
 * terminal registries and uses the same shared
 * `createGlobalSymbolRegistry` helper.
 *
 * A provider written before the glossary said change still names
 * its changes facet, and that facet's capabilities, `proposals`.
 * Such a provider can reach the shared slot from another package,
 * so every read hands it out saying `changes`.
 */

import { createGlobalSymbolRegistry } from "../../../internal/registry/global-symbol-registry.ts";
import type {
	Capabilities,
	CapabilitiesSayingProposals,
} from "../../review/capabilities.ts";
import type { RepoLocator } from "../../review/change.ts";
import type {
	ReviewProvider,
	ReviewProviderSayingProposals,
} from "../../review/provider.ts";

type Registered = ReviewProvider | ReviewProviderSayingProposals;

const registry = createGlobalSymbolRegistry<Registered>({
	slot: "pi:agentic-harness:review-providers",
	getId: (provider) => provider.id,
});

/** Each older provider's reading, made once so it keeps one identity. */
const readings = new WeakMap<ReviewProviderSayingProposals, ReviewProvider>();

/** Capabilities under their current names, whichever they were written with. */
function capabilitiesSayingChanges(
	declared: Capabilities | CapabilitiesSayingProposals,
): Capabilities {
	if (!("proposals" in declared)) return declared;
	const { proposals, ...rest } = declared;
	return proposals === undefined ? rest : { ...rest, changes: proposals };
}

/** Whether a provider still names its changes facet `proposals`. */
function saysProposals(
	provider: Registered,
): provider is ReviewProviderSayingProposals {
	return "proposals" in provider && !("changes" in provider);
}

/** A provider as callers use it, whichever names it was written with. */
export function sayingChanges(provider: Registered): ReviewProvider {
	if (!saysProposals(provider)) return provider;
	const known = readings.get(provider);
	if (known) return known;
	const { proposals, capabilities, ...rest } = provider;
	const reading: ReviewProvider = {
		...rest,
		capabilities: (repo: RepoLocator) =>
			capabilitiesSayingChanges(capabilities.call(provider, repo)),
		...(proposals ? { changes: proposals } : {}),
	};
	readings.set(provider, reading);
	return reading;
}

export const register = (provider: Registered): void =>
	registry.register(provider);
export const unregister = (id: string): void => registry.unregister(id);
export const clear = (): void => registry.clear();
export const get = (id: string): ReviewProvider | undefined => {
	const provider = registry.get(id);
	return provider && sayingChanges(provider);
};
export const list = (): ReviewProvider[] => registry.list().map(sayingChanges);
