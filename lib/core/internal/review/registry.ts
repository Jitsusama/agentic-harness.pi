/**
 * Review provider registry: process-global map from provider
 * id to `ReviewProvider`. Mirrors the tree, refs, people and
 * terminal registries and uses the same shared
 * `createGlobalSymbolRegistry` helper.
 *
 * A provider written before the glossary said change still names
 * its changes facet, and that facet's capabilities, `proposals`.
 * Such a provider can reach the shared slot from another package,
 * so every read hands it out saying `changes`. A stack node can
 * still name its change `proposal` too, from any provider, so every
 * stack read through the registry says `change`.
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
	StackingFacet,
} from "../../review/provider.ts";
import type { Stack, StackNode } from "../../review/stack.ts";

type Registered = ReviewProvider | ReviewProviderSayingProposals;

const registry = createGlobalSymbolRegistry<Registered>({
	slot: "pi:agentic-harness:review-providers",
	getId: (provider) => provider.id,
});

/** Each provider's reading, made once so it keeps one identity. */
const readings = new WeakMap<Registered, ReviewProvider>();

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

/** An older provider's facets under their current names. */
function facetsSayingChanges(
	provider: ReviewProviderSayingProposals,
): ReviewProvider {
	const { proposals, capabilities, ...rest } = provider;
	return {
		...rest,
		capabilities: (repo: RepoLocator) =>
			capabilitiesSayingChanges(capabilities.call(provider, repo)),
		...(proposals ? { changes: proposals } : {}),
	};
}

/** A node naming its change `change`, whichever name it was given. */
function nodeSayingChange(node: StackNode): StackNode {
	if (node.proposal === undefined) return node;
	const { proposal, ...rest } = node;
	return { ...rest, change: node.change ?? proposal };
}

/** A stack whose nodes all say `change`. */
function stackSayingChange(stack: Stack): Stack {
	return { ...stack, nodes: stack.nodes.map(nodeSayingChange) };
}

/** A stacking facet whose stacks all say `change`. */
function stackingSayingChange(stacking: StackingFacet): StackingFacet {
	const { stack, restack } = stacking;
	return {
		...stacking,
		stack: async (subject) =>
			stackSayingChange(await stack.call(stacking, subject)),
		...(restack
			? {
					restack: async (subject) =>
						stackSayingChange(await restack.call(stacking, subject)),
				}
			: {}),
	};
}

/** A provider as callers use it, whichever names it was written with. */
export function sayingChanges(provider: Registered): ReviewProvider {
	const known = readings.get(provider);
	if (known) return known;
	const current = saysProposals(provider)
		? facetsSayingChanges(provider)
		: provider;
	const reading: ReviewProvider = current.stacking
		? { ...current, stacking: stackingSayingChange(current.stacking) }
		: current;
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
