/**
 * A session's jobs, handed from the runtime a reload ends to the one it
 * starts.
 *
 * A reload evaluates every extension again, so nothing in a module
 * survives it, but the process does, and so does every job still
 * running in it: a bash command's shell, a fleet's subagents, a round's
 * reviewers. Their producers hold `Job` objects bound to the old
 * registry, so the registry itself is what is handed on, in a session
 * cell (on plain pi a `Symbol.for` key on `globalThis`, one per process;
 * on a host one per conversation, so a conversation's reload stops no
 * other's parked jobs), and the new runtime only rebinds it to its own
 * `pi`.
 *
 * What is left there is a way to adopt, defined by the old code and
 * called by the new, so the new code needs to know nothing of how the
 * old one held its jobs. The key carries a version: a change to what
 * `adopt` answers, or to what it is handed, takes a new one, and the
 * jobs parked under the old key are then stopped when nobody adopts
 * them, as every reload stopped them before.
 *
 * Adopting keeps the old code's outbox, so a process ran the outbox of
 * whichever version first built it through every reload: on 9 November
 * the steer #1101 added reached no session started before it (N3Q98W
 * [be0f9348]). So a runtime that can also hand off gives the new code
 * its jobs, the results still waiting and the ends not yet said, and
 * the new code builds its own session around them. Only the jobs
 * themselves stay the old code's, since their producers hold them.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type SessionCell, sessionCell } from "../../lib/core/session/index.ts";
import type { JobFinished } from "../../lib/jobs/index.ts";
import type { Jobs } from "./jobs.ts";
import type { JobSession } from "./lifecycle.ts";
import type { JobResult } from "./outbox.ts";

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
	/**
	 * Give the jobs to the taker's own code instead of adopting them.
	 * Absent where the parking runtime's code predates it.
	 */
	handOff?(): HandOff;
}

/** What jobs a registry reports to, rewired to whoever takes them. */
export interface JobWiring {
	post(result: JobResult): void;
	changed(): void;
	retract(jobId: string): boolean;
	ended(finished: JobFinished): void;
}

/** A parked session's jobs, handed to the code that takes them. */
export interface HandOff {
	readonly jobs: Jobs;
	/** Results not yet seen in the session, in the order they finished. */
	readonly waiting: readonly JobResult[];
	/** Jobs' ends heard while parked, not yet said on the bus. */
	readonly unsaid: readonly JobFinished[];
	/** From now on, the jobs report to these. */
	rewire(to: JobWiring): void;
}

interface Held {
	readonly parked: Parked;
	readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * Where parked jobs wait. The name and the shape of what is kept under it
 * are what every runtime since the key was minted reads, so it stays v1.
 */
const PARKED = "agentic-harness.jobs.parked.v1";

/** The cell parked jobs of `session` wait in, or the ambient session's. */
function parkedFor(session: string | undefined): SessionCell<Held> {
	return sessionCell<Held>(PARKED, session);
}

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
 * never takes them. Jobs an earlier runtime left in the same cell and
 * nobody took are stopped now: two runtimes' jobs cannot both be adopted.
 * On a host the cell is the conversation they are parked for, so another
 * conversation's parked jobs stay.
 */
export function park(parked: Parked, carryMs: number = CARRY_MS): void {
	const cell = parkedFor(parked.session);
	const earlier = cell.get();
	if (earlier) {
		clearTimeout(earlier.timer);
		earlier.parked.stop();
	}
	// Taking or replacing them clears this timer. A cell found empty is a
	// conversation its host closed while they waited, and they stop too.
	const timer = setTimeout(() => {
		const now = cell.get();
		if (now && now.parked !== parked) return;
		if (now) cell.clear();
		parked.stop();
	}, carryMs);
	timer.unref?.();
	cell.set({ parked, timer });
}

/**
 * Take over the jobs parked for `session`, or nothing when none were.
 * Jobs parked for another session are left for their wait to stop.
 */
export function takeParked(
	session: string | undefined,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	build?: (handed: HandOff) => JobSession,
): JobSession | undefined {
	const cell = parkedFor(session);
	const held = cell.get();
	if (!held || held.parked.session !== session) return undefined;
	clearTimeout(held.timer);
	cell.clear();
	try {
		const { parked } = held;
		return build && typeof parked.handOff === "function"
			? build(parked.handOff())
			: parked.adopt(pi, ctx);
	} catch {
		// Jobs that cannot be said through this runtime are stopped, as a
		// reload stopped them before; the session starts with none.
		held.parked.stop();
		return undefined;
	}
}
