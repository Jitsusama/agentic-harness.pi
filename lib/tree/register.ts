/**
 * Tree provider registration. Mirrors the refs, people and
 * terminal libraries: explicit registration for built-ins,
 * free functions for ad-hoc providers, an opt-out clear
 * for tests.
 */

import { BUILTIN_TREE_PROVIDERS } from "../internal/tree/builtins.js";
import { clear, register, unregister } from "../internal/tree/registry.js";
import type { TreeProvider } from "./types.js";

/**
 * Register a tree provider. Overwrites any previously
 * registered provider with the same id.
 */
export function registerTreeProvider(provider: TreeProvider): void {
	register(provider);
}

/** Remove a provider from the registry. Idempotent. */
export function unregisterTreeProvider(id: string): void {
	unregister(id);
}

/**
 * Seed the registry with the built-in providers. Currently
 * one entry: `git-worktree` at priority 100. Idempotent.
 */
export function registerBuiltinTreeProviders(): void {
	for (const provider of BUILTIN_TREE_PROVIDERS) register(provider);
}

/** Empty the registry. Intended for tests. */
export function clearTreeProviders(): void {
	clear();
}
