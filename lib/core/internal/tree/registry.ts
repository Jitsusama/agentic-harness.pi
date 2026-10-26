/**
 * Tree provider registry: process-global map from provider
 * id to `TreeProvider`. Mirrors the refs and terminal
 * libraries; uses the same shared `createGlobalSymbolRegistry`
 * helper.
 */

import type { TreeProvider } from "../../tree/types.ts";
import { createGlobalSymbolRegistry } from "../../../internal/registry/global-symbol-registry.ts";

const registry = createGlobalSymbolRegistry<TreeProvider>({
	slot: "pi:agentic-harness:tree-providers",
	getId: (p) => p.id,
});

export const register = (provider: TreeProvider): void =>
	registry.register(provider);
export const unregister = (id: string): void => registry.unregister(id);
export const clear = (): void => registry.clear();
export const get = (id: string): TreeProvider | undefined => registry.get(id);
export const list = (): TreeProvider[] => registry.list();
