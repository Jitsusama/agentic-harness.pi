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
import { type Unbacked, unbackedDeclarations } from "./backed.js";
import type { RepoLocator } from "./change.js";
import type { ReviewProvider } from "./provider.js";

/**
 * What a provider was found saying about itself that is not true.
 *
 * Reported rather than thrown. A provider with one bad declaration still does
 * everything else it says, and refusing to register it would take a working
 * backend off the surface over a capability nobody in this session is going to
 * reach for. The host says this out loud instead, which is the same bargain the
 * rest of the substrate makes about degradation.
 */
export interface ProviderComplaint {
	provider: string;
	repo: string;
	unbacked: Unbacked[];
}

/**
 * Register a provider. Replaces any provider already
 * registered under the same id.
 *
 * Pass a repo to have the provider's declarations checked against its methods
 * as it arrives, and act on whatever comes back. This is the only place that
 * check can be made of every provider: the ones that matter arrive over the
 * event bus from other packages, and a build-time gate cannot import one. For
 * weeks the answer to that was a hand-copied table in each package, which is
 * one rule and one guess about it.
 *
 * The repo is asked for rather than invented because a provider is entitled to
 * answer differently for different repos, and one handed a key from a space it
 * does not recognize returns a default and reports greens having compared
 * nothing.
 */
export function registerReviewProvider(
	provider: ReviewProvider,
	against?: RepoLocator,
): ProviderComplaint | undefined {
	register(provider);
	if (!against) return undefined;
	const unbacked = unbackedDeclarations(provider, against);
	return unbacked.length > 0
		? { provider: provider.id, repo: against.key, unbacked }
		: undefined;
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
