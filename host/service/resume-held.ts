/**
 * What a starting host does with the conversations its roster held: the
 * order it resumes them in, a few at once, and what became of each. Apart
 * from the control backend, which serves requests once the host listens,
 * since this changes with how a start paces its resumes.
 */
import type { RosterEntry } from "../../lib/core/session/roster.ts";
import type {
	BackendChildren,
	ConversationEngine,
	ResumePhase,
	Unresumed,
} from "./backend.ts";
import type { AdmitAnother } from "./rollout.ts";
import type { HostRoster } from "./roster.ts";

/** How a resume a start began ended: built, left parked, or still held unbuilt. */
export type ResumeEnd = "resumed" | "parked" | "unresumed";

/** A held conversation a starting host is about to resume, counted from one. */
export interface Resuming {
	readonly step: "resume";
	readonly number: number;
	readonly of: number;
	readonly sessionId: string;
}

/**
 * The order a start resumes what its roster held as it began: as held,
 * apart from those asked for (`ahead`), which go first, first asked
 * first. Only the start takes from it (`next`), says each it is done
 * with (`settled`), and ends it (`end`).
 */
export interface HeldOrder {
	/** How many the start owes as it begins. */
	readonly total: number;
	/**
	 * Bring it forward if the start still owes it, and settle once the
	 * start has resumed it or left it, failed included; at once for one it
	 * owes nothing, or once the start has ended.
	 */
	ahead(sessionId: string): Promise<void>;
	/** The next the start resumes, or none once it owes no more. */
	next(): RosterEntry | undefined;
	/** The start is done with it, resumed or not. */
	settled(sessionId: string): void;
	/** The start is over: whoever still waits is answered. */
	end(): void;
}

/** The order a start resumes what `roster` holds now. */
export function heldOrder(roster: HostRoster): HeldOrder {
	const rest = [...roster.entries()];
	const asked: RosterEntry[] = [];
	const owed = new Set(rest.map(({ sessionId }) => sessionId));
	const waiting = new Map<
		string,
		{ done: Promise<void>; settle: () => void }
	>();

	function settled(sessionId: string): void {
		owed.delete(sessionId);
		waiting.get(sessionId)?.settle();
		waiting.delete(sessionId);
	}

	return {
		total: rest.length,
		ahead(sessionId) {
			if (!owed.has(sessionId)) return Promise.resolve();
			const queued = rest.findIndex((held) => held.sessionId === sessionId);
			if (queued >= 0) asked.push(...rest.splice(queued, 1));
			let wait = waiting.get(sessionId);
			if (!wait) {
				let settle = (): void => undefined;
				const done = new Promise<void>((resolve) => {
					settle = resolve;
				});
				wait = { done, settle };
				waiting.set(sessionId, wait);
			}
			return wait.done;
		},
		next: () => asked.shift() ?? rest.shift(),
		settled,
		end() {
			for (const sessionId of [...owed]) settled(sessionId);
			rest.length = 0;
			asked.length = 0;
		},
	};
}

/**
 * How many conversations a start resumes together once one has resumed
 * alone. On 18 November a start of 81, one at a time, took 479 s, each
 * resume mostly waiting, its host's thread busy 43% of the time; more
 * than a few at once would only queue on that thread.
 */
export const RESUME_AT_ONCE = 4;

/**
 * Resume every held conversation at start, in the order they were held,
 * or as `order` brings one forward: alone until one has resumed, then
 * RESUME_AT_ONCE at a time, each taking the next as it ends. One that parked before the start and
 * rests parked (`restsParked`), which builds nothing, so passes no gate
 * and counts as parked rather than resumed. One whose session file is
 * gone (`lost`) can never resume, so it is dropped from the roster and
 * named in `dropped`: on 17 November a start kept 32 such holds that only
 * a person could have closed. Any other that can't resume stays held,
 * since only a deliberate close or release may drop a hold, and is
 * reported for a person to close or repair. With `admitAnother`, each
 * after the first that resumed must pass it, so the same one runs alone after every
 * restart and a refused one is parked with the open path's reason.
 * `starting` hears each one before it begins, so whoever waits on the
 * start knows it still moves; if it throws, that conversation stays held
 * and is reported like one that couldn't resume, and the rest go on.
 * `mark` hears each phase as it ends and `finished` each one's end,
 * resumed, parked or failed with why, under its own step, since several
 * run at once. A throw from `mark` at the phases this marks itself (ask
 * and gate) fails that conversation's resume; the engine's build hears it
 * too, so it must not throw there. One from `finished` fails the start,
 * once no resume is still building.
 * The runs a restart cut off wait until the last has resumed
 * (`resuming`, then `resumed`, also when one throws), so a few go at a
 * time in the whole start's order rather than racing the resumes; that
 * order is the one they asked in, roughly the order held, since a few
 * resume at once.
 * One no longer held when its turn comes, closed while the start ran,
 * is passed over. With `children`, one a child already runs, as one the
 * last host's child kept running, counts as resumed, and one that moves
 * and doesn't rest parked resumes in a child of its own. One `woken`
 * names was woken from a rest kept outside this process, by a child's
 * supervisor, so it is resumed as woken rather than asked whether it
 * rests parked, which would rest it again.
 */
export async function resumeHeld(options: {
	roster: HostRoster;
	engine: ConversationEngine;
	children?: BackendChildren;
	woken?: (entry: RosterEntry) => boolean;
	admitAnother?: AdmitAnother;
	starting?: (step: Resuming) => Promise<void>;
	mark?: (step: Resuming, phase: ResumePhase) => void;
	finished?: (step: Resuming, end: ResumeEnd, reason?: unknown) => void;
	order?: HeldOrder;
}): Promise<HeldResumed> {
	const resumed: string[] = [];
	const parked: string[] = [];
	const dropped: string[] = [];
	const unresumed: Unresumed[] = [];
	const order = options.order ?? heldOrder(options.roster);
	let number = 0;

	async function resumeOne(entry: RosterEntry): Promise<void> {
		number += 1;
		const { sessionId } = entry;
		const step: Resuming = {
			step: "resume",
			number,
			of: order.total,
			sessionId,
		};
		const mark = (phase: ResumePhase) => options.mark?.(step, phase);
		let began = false;
		let end: ResumeEnd = "unresumed";
		let failure: unknown;
		try {
			if (
				!options.roster.entries().some((held) => held.sessionId === sessionId)
			)
				return;
			// Dropped before it is said as resuming, since nothing resumes.
			if (options.engine.lost?.(entry)) {
				await options.roster.drop(sessionId);
				dropped.push(sessionId);
				return;
			}
			if (options.children?.running(sessionId)) {
				resumed.push(sessionId);
				return;
			}
			began = true;
			await options.starting?.(step);
			mark("ask");
			const woken = options.woken?.(entry) ?? false;
			if (!woken && options.engine.restsParked?.(entry)) {
				parked.push(sessionId);
				end = "parked";
				return;
			}
			if (resumed.length > 0) await options.admitAnother?.();
			mark("gate");
			if (options.children?.moves(sessionId))
				await options.children.resume(entry, false);
			else {
				// A child an earlier host left, which the adopt couldn't take
				// up, may run it still: never two processes on one file.
				await options.children?.left(sessionId);
				// One whose child became another while it waited is gone from the
				// roster, and runs on as that in its child, as one running is.
				if (
					!options.roster.entries().some((held) => held.sessionId === sessionId)
				) {
					resumed.push(sessionId);
					end = "resumed";
					return;
				}
				await options.engine.resume(entry, woken, mark);
			}
			resumed.push(sessionId);
			end = "resumed";
		} catch (reason) {
			unresumed.push({ sessionId, reason });
			failure = reason;
		} finally {
			order.settled(sessionId);
			if (began) options.finished?.(step, end, failure);
		}
	}

	/** Take the next as each ends, until the order owes no more. */
	async function resumeRest(): Promise<void> {
		for (let entry = order.next(); entry; entry = order.next())
			await resumeOne(entry);
	}

	options.engine.resuming?.(
		options.roster.entries().map((entry) => entry.sessionId),
	);
	try {
		// Alone until one resumes, so the rollout gate's first runs by itself.
		while (resumed.length === 0) {
			const entry = order.next();
			if (!entry) break;
			await resumeOne(entry);
		}
		// Every worker ends before the start does, so one that throws (a
		// listener's fault, since each resume's own is caught) leaves none
		// still building as the runs a restart cut off are let go.
		const rest = await Promise.allSettled(
			Array.from({ length: RESUME_AT_ONCE }, () => resumeRest()),
		);
		const failed = rest.find(
			(worker): worker is PromiseRejectedResult => worker.status === "rejected",
		);
		if (failed) throw failed.reason;
	} finally {
		order.end();
		options.engine.resumed?.();
	}
	return { resumed, parked, dropped, unresumed };
}

/** What a start did with each conversation the host held. */
export interface HeldResumed {
	/** Built and running again, in the order they finished. */
	readonly resumed: string[];
	/** Left parked as their last process parked them, building nothing. */
	readonly parked: string[];
	/** Dropped from the roster, since their session files are gone. */
	readonly dropped: string[];
	/** Still held but not running, each with why it would not resume. */
	readonly unresumed: Unresumed[];
}
