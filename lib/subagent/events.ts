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
 * Listening to this is enough only for an extension that activates
 * after this one. Anything that might activate first registers by
 * emitting, which is why the handshake goes both ways.
 */
export const SUBAGENT_READY = "subagent:ready:v1";

/**
 * Reverse registration for an extension every subagent should load.
 *
 * Payload is the absolute path. Listened for over the session's whole
 * life, so an extension that activated before the host is not too
 * late.
 */
export const SUBAGENT_REGISTER_DEFAULT_EXTENSION =
	"subagent:register-default-extension:v1";

/** Reverse registration for a skill every subagent should load. */
export const SUBAGENT_REGISTER_DEFAULT_SKILL =
	"subagent:register-default-skill:v1";
