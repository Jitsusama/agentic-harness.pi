/**
 * Provider resolution: pick the active tree provider for a
 * given repo root.
 *
 * Resolution order: every registered provider, sorted by
 * `priority` ascending (smaller numbers first); the first
 * whose `appliesTo(repoRoot)` returns true wins. Built-ins
 * live at 100; downstream packages use lower numbers to
 * take over.
 */

import { get, list } from "../internal/tree/registry.js";
import type { TreeProvider } from "./types.js";

/** Look up a provider by id, or `undefined`. */
export function getTreeProvider(id: string): TreeProvider | undefined {
	return get(id);
}

/** Snapshot of every registered provider. */
export function listTreeProviders(): TreeProvider[] {
	return list();
}

/**
 * Resolve the tree provider for a repo root. Returns
 * `undefined` when no registered provider applies.
 */
export function resolveTreeProvider(
	repoRoot: string,
): TreeProvider | undefined {
	const ranked = [...list()].sort((a, b) => a.priority - b.priority);
	for (const provider of ranked) {
		if (provider.appliesTo(repoRoot)) return provider;
	}
	return undefined;
}
