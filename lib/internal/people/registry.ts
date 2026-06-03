/**
 * Handle-type registry: process-global map from handle
 * type identifier to `HandleType`. Symmetric with the
 * refs/tree/terminal registries; uses the shared
 * `createGlobalSymbolRegistry` helper.
 */

import type { HandleType } from "../../people/types.js";
import { createGlobalSymbolRegistry } from "../registry/global-symbol-registry.js";

const registry = createGlobalSymbolRegistry<HandleType>({
	slot: "pi:agentic-harness:people-handle-types",
	getId: (h) => h.type,
});

export const register = (handleType: HandleType): void =>
	registry.register(handleType);
export const unregister = (type: string): void => registry.unregister(type);
export const clear = (): void => registry.clear();
export const get = (type: string): HandleType | undefined => registry.get(type);
export const list = (): HandleType[] => registry.list();
