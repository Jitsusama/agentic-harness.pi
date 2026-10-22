/**
 * The bus names the subagent domain answers to.
 *
 * Declared here rather than in the extension that emits them, and the
 * distinction is the whole point of the seam. A downstream package
 * registering a default extension needs the name; while the name lived
 * in `extensions/subagent-workflow`, getting it meant importing that
 * extension or hardcoding the string, and both of those are the
 * coupling the bus exists to remove. A consumer needs the library and
 * never another extension.
 *
 * The names say `subagent`, not `subagent-workflow`. A topic belongs
 * to a domain; naming it after the extension that happens to host it
 * today means a second host, or a rename, breaks every listener for a
 * reason that has nothing to do with them.
 */

/**
 * Emitted once the subagent tool is registered, carrying its API.
 *
 * pi's bus is a plain emitter that keeps nothing, so this reaches only
 * an extension already listening: one that activated before the host.
 * One that activates after it has missed this and registers by
 * emitting instead. Not knowing its order, a registrant does both,
 * which is why the handshake goes both ways.
 */
export const SUBAGENT_READY = "subagent:ready:v1";

/**
 * Reverse registration for an extension every subagent should load.
 *
 * Payload is the absolute path. The host listens from its activation
 * to the end of the session, so this reaches it from an extension that
 * activates after it. Emitted before the host activates, it reaches
 * nothing and is lost; that case is what {@link SUBAGENT_READY} covers.
 */
export const SUBAGENT_REGISTER_DEFAULT_EXTENSION =
	"subagent:register-default-extension:v1";

/** Reverse registration for a skill every subagent should load. */
export const SUBAGENT_REGISTER_DEFAULT_SKILL =
	"subagent:register-default-skill:v1";
