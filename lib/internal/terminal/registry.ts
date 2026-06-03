/**
 * Terminal driver registry: process-global map from driver
 * id to `TerminalDriver`. Symmetric with refs and tree
 * registries; uses the shared `createGlobalSymbolRegistry`
 * helper.
 */

import type { TerminalDriver } from "../../terminal/types.js";
import { createGlobalSymbolRegistry } from "../registry/global-symbol-registry.js";

const registry = createGlobalSymbolRegistry<TerminalDriver>({
	slot: "pi:agentic-harness:terminal-drivers",
	getId: (d) => d.id,
});

export const register = (driver: TerminalDriver): void =>
	registry.register(driver);
export const unregister = (id: string): void => registry.unregister(id);
export const clear = (): void => registry.clear();
export const get = (id: string): TerminalDriver | undefined => registry.get(id);
export const list = (): TerminalDriver[] => registry.list();
