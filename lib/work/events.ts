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

/**
 * Emitted before reclaiming trees, asking who else holds one.
 *
 * The working layer is not the only thing that cuts a worktree. A
 * quest holds trees against a piece of work and knows nothing about
 * this broker's memory, and any other package may do the same. From
 * git's side those are indistinguishable from a tree somebody leaked:
 * the directory is there, the broker has no record, and every check
 * short of asking says abandoned.
 *
 * So reclamation asks first, and anything holding trees answers by
 * pushing its paths onto {@link TreeClaims.paths}. Silence is the
 * dangerous default here rather than the safe one, which is why this
 * is a broadcast question and not a lookup against a registry: an
 * owner that never registered still gets to speak, and an owner that
 * is not loaded cannot be spoken for.
 */
export const WORK_TREE_CLAIMS = "work:tree-claims:v1";

/** What holders write their trees into, in answer to the question. */
export interface TreeClaims {
	/**
	 * Every tree some other substrate is holding.
	 *
	 * Appended to rather than returned, because there is no telling how
	 * many holders exist and a handler that replaced this would silently
	 * drop the answers of everything that ran before it.
	 */
	paths: string[];
}

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
