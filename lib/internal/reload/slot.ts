/**
 * What one runtime hands the next across a reload.
 *
 * A reload evaluates every extension again, so nothing in a module
 * survives it, and the code that asked for the reload is the old code.
 * A `Symbol.for` key on `globalThis` does survive, since the process and
 * its realm stay the same. The old runtime leaves its request here; the
 * new one leaves the function that says the reload landed, and the old
 * command calls it once the reload has returned, by which time every
 * new extension has started.
 */

/** A reload somebody asked for, and what it is to load. */
export interface ReloadRequest {
	/** Why, in the asker's words; said back when it lands. */
	readonly reason: string;
	/** The tree to load in place of the install; absent for the install. */
	readonly tree?: string;
	/**
	 * The agent asked through the tool, the person through the command,
	 * or the session itself because its install moved.
	 */
	readonly by: "agent" | "person" | "self";
}

/** How a reload went, for whoever says it landed. */
export interface ReloadLanded extends ReloadRequest {
	/** False when the settings changed under the reload and were left as found. */
	readonly restored?: boolean;
}

/** The slot itself. */
export interface ReloadSlot {
	/** The request waiting for the run to end, or under way. */
	request?: ReloadRequest;
	/** The request has been handed to the command. */
	dispatched?: boolean;
	/**
	 * The command's reload is under way. A runtime that starts while this
	 * is unset was started by something else (pi's own `/reload`, a new
	 * session), and any request left over belongs to the code before it.
	 */
	reloading?: boolean;
	/**
	 * A reload command is running, from its wait for stillness until its
	 * reload has landed. pi's reload is not one at a time: a second begun
	 * while the first loads leaves a runtime that is never made stale, so
	 * a command that finds this set does nothing.
	 */
	performing?: boolean;
	/** Left by the newest runtime: say that a reload landed. */
	landed?: (landed: ReloadLanded) => void;
	/**
	 * A landing no runtime could say, because the one that tried had been
	 * replaced before it spoke; the next runtime to start says it.
	 */
	unsaid?: ReloadLanded;
}

const SLOT_KEY = Symbol.for("agentic-harness.reload.slot");

type SlotGlobal = { [SLOT_KEY]?: ReloadSlot };

/** The process's one slot, made on first use. */
export function reloadSlot(): ReloadSlot {
	const global = globalThis as SlotGlobal;
	global[SLOT_KEY] ??= {};
	return global[SLOT_KEY];
}
