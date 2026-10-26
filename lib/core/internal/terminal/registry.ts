/**
 * Terminal driver registry: process-global map from driver
 * id to `TerminalDriver`. Symmetric with refs and tree
 * registries; uses the shared `createGlobalSymbolRegistry`
 * helper.
 */

import { createGlobalSymbolRegistry } from "../../../internal/registry/global-symbol-registry.ts";
import type { TerminalDriver } from "../../terminal/types.ts";

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
