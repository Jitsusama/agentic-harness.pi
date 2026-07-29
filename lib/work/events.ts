/**
 * The bus contract between the working layer and its providers.
 *
 * A provider registers over the event bus rather than by importing
 * the registry, so it can live in a different package from the host
 * without either depending on the other's module graph. The names
 * are versioned because the payload is a public contract; a breaking
 * change ships as `:v2` beside the old one rather than quietly
 * changing what `:v1` means.
 *
 * The names are owned by the domain, `work:`, not by whichever
 * extension happens to host it. An event named after an extension
 * makes every other extension depend on that one's continued
 * existence, which is the coupling the bus is here to avoid.
 *
 * Both directions of the handshake matter. The host emits
 * {@link WORK_READY} when its registry is live, and a provider
 * listens for it so it can re-register after the host reloads. A
 * provider also emits {@link WORK_REGISTER_TREE_PROVIDER} on its own
 * activation, in case the host was already up. Either order works,
 * and both are idempotent because registration replaces by id.
 *
 * A consumer needs the same courtesy for the opposite reason. The
 * bus does not replay, so a consumer that activated after the host
 * missed the announcement and has no way to know it happened.
 * {@link WORK_REQUEST} is how it asks; the host answers by
 * announcing itself again. Load order therefore decides nothing,
 * which is the point: an extension cannot choose when it is loaded
 * relative to another.
 */

import type { TreeBroker, TreeProvider } from "./broker.js";

/** Emitted by the host once its registry accepts providers. */
export const WORK_READY = "work:ready:v1";

/** Emitted by a provider to register itself with the host. */
export const WORK_REGISTER_TREE_PROVIDER = "work:tree-provider:register:v1";

/**
 * Emitted by a consumer asking the host to announce itself, for when
 * the consumer loaded second and missed {@link WORK_READY}.
 */
export const WORK_REQUEST = "work:request:v1";

/** What the host hands out over {@link WORK_READY}. */
export interface WorkApi {
	/** Register a tree provider. Replaces one with the same id. */
	registerTreeProvider(provider: TreeProvider): void;
	/** Ids of every registered provider, most specific first. */
	listTreeProviders(): readonly string[];
	/**
	 * The host's own broker.
	 *
	 * Shared rather than rebuilt, so a consumer works against the
	 * same held trees the host does. A consumer with its own broker
	 * would hold a second set of trees for the same commits, cut
	 * them twice, and release each other's out from under them.
	 */
	broker(): TreeBroker;
}
