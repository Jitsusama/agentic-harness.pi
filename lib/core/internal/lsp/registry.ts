/**
 * LSP backend registry: process-global map from backend name to
 * `LspBackendEntry`. Mirrors the refs, terminal and tree
 * libraries; uses the same shared `createGlobalSymbolRegistry`
 * helper.
 */

import type { LspBackendEntry } from "../../lsp/types.ts";
import { createGlobalSymbolRegistry } from "../../../internal/registry/global-symbol-registry.ts";

const registry = createGlobalSymbolRegistry<LspBackendEntry>({
	slot: "pi:agentic-harness:lsp-backends",
	getId: (entry) => entry.name,
});

export const register = (entry: LspBackendEntry): void =>
	registry.register(entry);
export const unregister = (name: string): void => registry.unregister(name);
export const clear = (): void => registry.clear();
export const get = (name: string): LspBackendEntry | undefined =>
	registry.get(name);
export const list = (): LspBackendEntry[] => registry.list();
