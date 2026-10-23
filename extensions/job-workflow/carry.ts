/**
 * A session's jobs, handed from the runtime a reload ends to the one it
 * starts.
 *
 * A reload evaluates every extension again, so nothing in a module
 * survives it, but the process does, and so does every job still
 * running in it: a bash command's shell, a fleet's subagents, a round's
 * reviewers. Their producers hold `Job` objects bound to the old
 * registry, so the registry itself is what is handed on, under a
 * `Symbol.for` key on `globalThis`, and the new runtime only rebinds it
 * to its own `pi`.
 *
 * What is left there is a way to adopt, defined by the old code and
 * called by the new, so the new code needs to know nothing of how the
 * old one held its jobs. The key carries a version: a change to what
 * `adopt` answers, or to what it is handed, takes a new one, and the
 * jobs parked under the old key are then stopped when nobody adopts
 * them, as every reload stopped them before.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { JobSession } from "./lifecycle.ts";

/**
 * How long parked jobs wait to be adopted before they are stopped. A
 * reload starts the new runtime within seconds; this is long enough for
 * a slow one and costs only minutes of unheard work when the new code
 * cannot adopt at all, such as a reload onto code from before this.
 */
export const CARRY_MS = 5 * 60_000;

/** Jobs parked by a runtime a reload is ending. */
export interface Parked {
	/** The session they belong to, when it could be read. */
	readonly session: string | undefined;
	/** Take them over, saying their results through `pi` from now on. */
	adopt(pi: ExtensionAPI, ctx: ExtensionContext): JobSession;
	/** Stop them, as a session ending does. */
	stop(): void;
}

interface Held {
	readonly parked: Parked;
	readonly timer: ReturnType<typeof setTimeout>;
}

const PARKED_KEY = Symbol.for("agentic-harness.jobs.parked.v1");

type ParkedGlobal = { [PARKED_KEY]?: Held };

/** The session a context belongs to, or undefined when it cannot say. */
export function sessionIdOf(ctx: ExtensionContext): string | undefined {
	try {
		return ctx.sessionManager.getSessionId();
	} catch {
		// A context without a session manager, or a stale one: unnamed.
		return undefined;
	}
}

/**
 * Leave jobs for the next runtime, stopping them after `carryMs` if it
 * never takes them. Jobs an earlier runtime left and nobody took are
 * stopped now: two runtimes' jobs cannot both be adopted.
 */
export function park(parked: Parked, carryMs: number = CARRY_MS): void {
	const global = globalThis as ParkedGlobal;
	const earlier = global[PARKED_KEY];
	if (earlier) {
		clearTimeout(earlier.timer);
		earlier.parked.stop();
	}
	const timer = setTimeout(() => {
		if (global[PARKED_KEY]?.parked !== parked) return;
		delete global[PARKED_KEY];
		parked.stop();
	}, carryMs);
	timer.unref?.();
	global[PARKED_KEY] = { parked, timer };
}

/**
 * Take over the jobs parked for `session`, or nothing when none were.
 * Jobs parked for another session are left for their wait to stop.
 */
export function takeParked(
	session: string | undefined,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): JobSession | undefined {
	const global = globalThis as ParkedGlobal;
	const held = global[PARKED_KEY];
	if (!held || held.parked.session !== session) return undefined;
	clearTimeout(held.timer);
	delete global[PARKED_KEY];
	try {
		return held.parked.adopt(pi, ctx);
	} catch {
		// Jobs that cannot be said through this runtime are stopped, as a
		// reload stopped them before; the session starts with none.
		held.parked.stop();
		return undefined;
	}
}
