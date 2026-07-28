/**
 * The bus contract between the substrate and its providers.
 *
 * A provider registers over the event bus rather than by
 * importing the registry, so a provider can live in a
 * different package from the host without either one
 * depending on the other's module graph. The names are
 * versioned because the payload is a public contract; a
 * breaking change ships as `:v2` beside the old one rather
 * than quietly changing what `:v1` means.
 *
 * Both directions of the handshake matter. The host emits
 * `REVIEW_READY` when its registry is live, and a provider
 * listens for it so it can re-register after the host
 * reloads. A provider also emits `REVIEW_REGISTER_PROVIDER`
 * on its own activation, in case the host was already up.
 * Either order works, and both are idempotent.
 */

import type { ReviewProvider } from "./provider.js";

/** Emitted by the host once its registry accepts providers. */
export const REVIEW_READY = "review:ready:v1";

/** Emitted by a provider to register itself with the host. */
export const REVIEW_REGISTER_PROVIDER = "review:provider:register:v1";

/** What the host hands out over {@link REVIEW_READY}. */
export interface ReviewSubstrateApi {
	/** Register a provider. Replaces one with the same id. */
	registerProvider(provider: ReviewProvider): void;
	/** Ids of every registered provider, in claim order. */
	listProviders(): readonly string[];
}
