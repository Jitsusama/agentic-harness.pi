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
 *
 * A consumer needs the same courtesy for the opposite reason.
 * The bus does not replay, so a consumer that activated after
 * the host missed the announcement and has no way to know it
 * happened. `REVIEW_REQUEST_SUBSTRATE` is how it asks; the host
 * answers by announcing itself again. Load order therefore
 * decides nothing, which is the point: an extension cannot
 * choose when it is loaded relative to another.
 */

import type { ReviewEngine } from "./engine.js";
import type { ReviewProvider } from "./provider.js";

/** Emitted by the host once its registry accepts providers. */
export const REVIEW_READY = "review:ready:v1";

/** Emitted by a provider to register itself with the host. */
export const REVIEW_REGISTER_PROVIDER = "review:provider:register:v1";

/**
 * Emitted by a consumer asking the host to announce itself, for
 * when the consumer loaded second and missed {@link REVIEW_READY}.
 */
export const REVIEW_REQUEST_SUBSTRATE = "review:request:v1";

/** What the host hands out over {@link REVIEW_READY}. */
export interface ReviewSubstrateApi {
	/** Register a provider. Replaces one with the same id. */
	registerProvider(provider: ReviewProvider): void;
	/** Ids of every registered provider, in claim order. */
	listProviders(): readonly string[];
	/**
	 * The host's own engine.
	 *
	 * Shared rather than rebuilt, so a consumer resolves against
	 * the same registry the host announced. A consumer with its
	 * own engine would see only the providers it registered
	 * itself, which means a provider that arrived over the bus
	 * would be invisible to it: exactly the case this contract
	 * exists to serve.
	 *
	 * Asked for rather than handed over, because building it
	 * means reading configuration from disk, and the
	 * announcement cannot wait on that.
	 */
	engine(): Promise<ReviewEngine>;
}
