/**
 * Review provider registry: process-global map from provider
 * id to `ReviewProvider`. Mirrors the tree, refs, people and
 * terminal registries and uses the same shared
 * `createGlobalSymbolRegistry` helper.
 */

import { createGlobalSymbolRegistry } from "../../../internal/registry/global-symbol-registry.ts";
import type { ReviewProvider } from "../../review/provider.ts";

const registry = createGlobalSymbolRegistry<ReviewProvider>({
	slot: "pi:agentic-harness:review-providers",
	getId: (provider) => provider.id,
});

export const register = (provider: ReviewProvider): void =>
	registry.register(provider);
export const unregister = (id: string): void => registry.unregister(id);
export const clear = (): void => registry.clear();
export const get = (id: string): ReviewProvider | undefined => registry.get(id);
export const list = (): ReviewProvider[] => registry.list();
