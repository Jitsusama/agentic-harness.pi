/**
 * Provider registration. Mirrors the tree library: explicit
 * registration for built-ins, free functions for ad-hoc
 * providers, an opt-out clear for tests.
 *
 * Listing sorts by claim priority rather than registration
 * order, because the order providers are asked in is part of
 * the contract and no caller should have to re-sort to get
 * it right.
 */

import {
	clear,
	get,
	list,
	register,
	unregister,
} from "../internal/review/registry.js";
import type { ReviewProvider } from "./provider.js";

/**
 * Register a provider. Replaces any provider already
 * registered under the same id.
 */
export function registerReviewProvider(provider: ReviewProvider): void {
	register(provider);
}

/** Remove a provider from the registry. Idempotent. */
export function unregisterReviewProvider(id: string): void {
	unregister(id);
}

/** Look up a provider by id. */
export function getReviewProvider(id: string): ReviewProvider | undefined {
	return get(id);
}

/** Every registered provider, in the order they are asked. */
export function listReviewProviders(): ReviewProvider[] {
	return [...list()].sort((a, b) => a.priority - b.priority);
}

/** Empty the registry. Intended for tests. */
export function clearReviewProviders(): void {
	clear();
}
