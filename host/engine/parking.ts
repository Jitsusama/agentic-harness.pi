/**
 * Parking an idle conversation and waking it: the host stops it as a
 * host stop does, keeping its hold, and watches the wake file each
 * conversation is told of in MYCELIUM_WAKE, as a holder watches plain
 * pi's, until it is written, a viewer types or a window opens on it.
 * A wake through the file that is refused is kept beside it, with the
 * message that asked, for the mesh to say (refused-wake.ts), until the
 * conversation next runs.
 *
 * While it rests the host also watches its steer inboxes, under the
 * addresses its park marker names, and wakes it the same way as soon as
 * a steer lands that waits on it running (watchWakingSteers in lib/mesh/parked.ts): a talk, a
 * close, a carry, a move or a fill. The mesh's once-a-minute pass stays
 * as the backstop.
 *
 * Where the host keeps a carried bash call alive (`carries`), a park
 * carries the conversation's calls as a restart does, and the calls it
 * carried wake it once the last one ends (parked-calls.ts). Their record
 * outlives a wake that fails, going only once the conversation runs
 * (`ran`); one that can't be written wakes it as soon as it parks, and
 * a close for good stops the calls, which nobody would take up.
 *
 * While the host drains for a restart (`holding`), a wake through the
 * file or a steer is held: the file stays on disk and the steer in its
 * inbox, so a conversation parked to let the host restart stays parked.
 * Lifting the drain (`release`) wakes each one asked for meanwhile, and
 * the next host's `rests` reads the file left for it. A viewer typing or
 * a window opening is never held.
 *
 * A drain holds them only until its restart passes the settle ceiling
 * (`letThrough`): from then the host waits for a gap, which background
 * work can put off for hours. From 05:02 on 17 November 13 parked
 * sessions sat on unread wakes that way, questions to them unheard for
 * 1.5 to 3.5 h. Past it, each one held is woken and the rest go through
 * at once, while the drain itself stays for the gap: one woken parks
 * again as soon as it is idle. As the restart comes, or the host stops,
 * they are held again, so one written then waits for the next host.
 */
import {
	existsSync,
	type FSWatcher,
	mkdirSync,
	readFileSync,
	rmSync,
	watch,
} from "node:fs";
import { join } from "node:path";
import {
	clearRefusedWake,
	type RefusedWake,
	takeBackRefusedWakeOff,
	wakeAskedBy,
	writeRefusedWakeOff,
} from "../../lib/internal/session/refused-wake.ts";
import type { CarriedShell } from "../../lib/internal/shell/carried.ts";
import { type SteerWatch, watchWakingSteers } from "../../lib/mesh/parked.ts";
import {
	carriedCalls,
	forgetCarriedCalls,
	hearParkCarry,
	keepCarriedCalls,
	stopCarriedCalls,
	watchCarriedCalls,
} from "./parked-calls.ts";

/** The file inside a conversation's folder that, once written, wakes it from a park. */
const WAKE_FILE = "wake";

/** What a wake file holds, or nothing where it went before it was read. */
function readWritten(file: string): string {
	try {
		return readFileSync(file, "utf8");
	} catch {
		// Gone between its event and this read: a wake that names no message.
		return "";
	}
}

/** Why a parked conversation's session ended, as its stop says. */
export const PARKED = "parked while idle";

/**
 * How long a conversation whose carried calls couldn't be recorded
 * carries none: a write fault (a full disk, a folder it can't write)
 * rarely clears in minutes, and each park it can't record ends in a
 * wake, a whole pi start, so it holds its calls awake for an hour.
 */
export const UNRECORDED_HOLDS_MS = 60 * 60 * 1000;

/** What parks and wakes the engine's conversations. */
export interface Parking {
	/** Where a sender wakes this conversation once it parks. */
	wakeFile(sessionId: string): string;
	/** It runs now: a wake left from an earlier park would wake its next at once. */
	running(sessionId: string): void;
	/** Park it, then watch for its wake; a wake asked meanwhile wakes it once parked. */
	park(sessionId: string): Promise<void>;
	/**
	 * It parked under an earlier host and still rests: watch for its wake
	 * as its park would have, waking it for one written meanwhile.
	 */
	rests(sessionId: string): void;
	/**
	 * It is asked for: wake it, or once its park settles. Settles once the
	 * wake has, rejecting with why it failed, so whoever asked can say so
	 * and ask again.
	 */
	wake(sessionId: string): Promise<void>;
	/** Once a park of it under way has settled, at once when none is. */
	settled(sessionId: string): Promise<void>;
	/** Whether its wake is watched now, as a woken one's is until it moves out. */
	watches(sessionId: string): boolean;
	/**
	 * It resumed, or a child took it on: stop watching for its wake, and
	 * forget a wake refused it as it started, after `running` cleared the
	 * last.
	 */
	unwatch(sessionId: string): void;
	/** It runs again, having taken up from its log the calls its park carried: forget them. */
	ran(sessionId: string): void;
	/**
	 * Whether a park of it may carry its bash calls: not for
	 * `UNRECORDED_HOLDS_MS` after its calls couldn't be recorded, so it
	 * stays awake holding them rather than parking and waking in a loop.
	 */
	mayCarry(sessionId: string): boolean;
	/**
	 * It was closed: stop watching, and forget a wake refused it. Closed
	 * `forGood`, the calls its park carried are stopped, since nobody
	 * takes them up; released to another holder, they are only forgotten,
	 * for that holder takes them up from its log.
	 */
	closed(sessionId: string, forGood: boolean): void;
	/**
	 * Hear the bash calls its bus says a park of it carried, to wake it once
	 * they end. Answers the disposer.
	 */
	hears(
		sessionId: string,
		bus: {
			on(channel: string, listener: (data: unknown) => void): () => void;
		},
	): () => void;
	/** The drain lifted: wake each one asked for through its file or a steer while it held. */
	release(): void;
	/**
	 * Whether the drain's restart is past its ceiling, waiting for a gap:
	 * if so, hold no wake or steer until the drain lifts or this says not,
	 * and wake each one held. Answers how many it woke as it began letting
	 * them through, so the host journals that once; nothing when it
	 * already did, holds them again, or the host doesn't drain.
	 */
	letThrough(on: boolean): number | undefined;
}

/** A parked conversation's watches, until it wakes or is closed. */
interface Sleeper {
	readonly wake: FSWatcher;
	/** Aborted as it stops being watched, when no refusal of its wake is true. */
	readonly gone: AbortController;
	steers?: SteerWatch;
	/** A steer's wake is asked and not yet settled. */
	waking?: boolean;
	/** Look at its wake file again, waking it for one written, and say whether it did. */
	woken?: () => boolean;
	/** Wake it for this steer. */
	steered?: (steer: string) => void;
	/** A steer that landed while the host held its wakes. */
	heldSteer?: string;
	/** Stops looking at the bash calls its park carried. */
	calls?: () => void;
}

/** Where the person's steers wait, and whose they are for each conversation. */
export interface SteerInboxes {
	/** The steer root, one inbox an address under it. */
	readonly root: string;
	/** The addresses a parked conversation answers to, as it parked. */
	readonly addressesOf: (sessionId: string) => readonly string[];
}

/** A park under way: when it settles, and the wakes asked of it meanwhile. */
interface Settling {
	readonly done: Promise<void>;
	readonly asked: { resolve(): void; reject(error: unknown): void }[];
}

/**
 * Park conversations under `stateDir`, each in its own folder there.
 * `stop` ends its session as a host stop does; `asking` is what wakes
 * one, the service's wake once it listens.
 */
export function parking(options: {
	readonly stateDir: string;
	/** The clock; Date.now by default. */
	readonly now?: () => number;
	/** Ends its session as a host stop does, `carrying` its bash calls where the host keeps them. */
	readonly stop: (
		sessionId: string,
		why: string,
		carrying: boolean,
	) => Promise<void>;
	readonly asking: () => ((sessionId: string) => Promise<void>) | undefined;
	readonly report: (error: unknown) => void;
	/** It parked: said before its wake is watched, so any wake comes after. */
	readonly parked?: (sessionId: string) => void;
	/** Its steer inboxes, watched while it rests; none, only the wake file wakes it. */
	readonly steers?: SteerInboxes;
	/** Whether wakes through the file and steers are held now, as the host drains. */
	readonly holding?: () => boolean;
	/**
	 * Whether the host keeps a carried bash call alive through a stop, so a
	 * park carries them (carried-shells.ts); none, it carries none.
	 */
	readonly carries?: () => boolean;
	/** Whether a carried call still runs; its shell, read from the machine, by default. */
	readonly callRuns?: (work: CarriedShell) => boolean | Promise<boolean>;
	/** How often a parked conversation's carried calls are looked at; CALLS_LOOK_MS by default. */
	readonly lookEveryMs?: number;
	/** How long before a wake for ended calls is asked again; CALLS_WAKE_AGAIN_MS by default. */
	readonly wakeAgainMs?: number;
	/** A line for the journal: a park that carried calls, and their end. */
	readonly said?: (line: string) => void;
	/** Keeps a refused wake, unless `signal` aborts first; on disk off the thread unless a test says. */
	readonly keepRefusal?: (
		wake: string,
		refused: RefusedWake,
		signal: AbortSignal,
	) => Promise<boolean>;
}): Parking {
	const keepRefusal = options.keepRefusal ?? writeRefusedWakeOff;
	// Whether this drain's restart passed its ceiling, until the drain lifts.
	let through = false;
	const holding = () => !through && options.holding?.() === true;
	const { stateDir, report } = options;
	// Parked conversations, each watching its wake file until it wakes or is closed.
	const sleepers = new Map<string, Sleeper>();
	// Conversations parking now.
	const settling = new Map<string, Settling>();
	// Conversations whose stop for a park is under way, whose carried calls are theirs to watch.
	const stopping = new Set<string>();
	// Conversations whose park carried calls it couldn't record, woken once parked.
	const unrecorded = new Map<string, CarriedShell[]>();
	// Conversations whose calls couldn't be recorded, and until when they carry none.
	const uncarried = new Map<string, number>();
	const now = options.now ?? Date.now;
	const mayCarry = (sessionId: string): boolean => {
		const until = uncarried.get(sessionId);
		if (until === undefined) return true;
		if (now() < until) return false;
		uncarried.delete(sessionId);
		return true;
	};
	const folderOf = (sessionId: string) => join(stateDir, sessionId);
	const wakeFile = (sessionId: string) => join(folderOf(sessionId), WAKE_FILE);

	function stopWatching(sessionId: string): void {
		const sleeper = sleepers.get(sessionId);
		sleeper?.gone.abort();
		sleeper?.wake.close();
		sleeper?.steers?.close();
		sleeper?.calls?.();
		sleepers.delete(sessionId);
	}

	// Once it runs or is closed, no refusal of a wake says anything true.
	function forget(sessionId: string): void {
		stopWatching(sessionId);
		clearRefusedWake(wakeFile(sessionId));
	}

	function watchWake(sessionId: string, held?: readonly CarriedShell[]): void {
		stopWatching(sessionId);
		const file = wakeFile(sessionId);
		mkdirSync(folderOf(sessionId), { recursive: true });
		// Woken for `messageId`, or for nothing named; a refusal is kept
		// beside its file. `settled` is told as the wake is answered, before
		// any refusal is kept, since keeping one waits on the disk.
		const ask = (
			watching: Sleeper,
			messageId: string | undefined,
			settled?: () => void,
		) =>
			wake(sessionId).then(settled, async (error: unknown) => {
				settled?.();
				// Reported as it failed; kept for the mesh to say, until the next
				// message writes the file again or the conversation runs. One
				// settling once this watch is gone, at a close or another park,
				// would outlive what cleared it: so it isn't put in place once the
				// watch goes, and one already renamed then is taken back.
				if (sleepers.get(sessionId) !== watching) return;
				const refused: RefusedWake = {
					...(messageId === undefined ? {} : { messageId }),
					reason: error instanceof Error ? error.message : String(error),
					at: new Date().toISOString(),
				};
				try {
					const kept = await keepRefusal(file, refused, watching.gone.signal);
					if (kept && sleepers.get(sessionId) !== watching)
						await takeBackRefusedWakeOff(file, refused);
				} catch (unkept) {
					report(unkept);
				}
			});
		// Whether it asked a wake, so a release asks no second for a held steer.
		const woken = (): boolean => {
			const watching = sleepers.get(sessionId);
			if (!watching || !existsSync(file) || holding()) return false;
			const messageId = wakeAskedBy(readWritten(file));
			rmSync(file, { force: true });
			watching.heldSteer = undefined;
			void ask(watching, messageId);
			return true;
		};
		// A steer landing while its wake is asked would ask the same wake again.
		const steered = (steer: string) => {
			const watching = sleepers.get(sessionId);
			if (!watching || watching.waking) return;
			if (holding()) {
				watching.heldSteer = steer;
				return;
			}
			watching.heldSteer = undefined;
			watching.waking = true;
			void ask(watching, `steer-${steer}`, () => {
				watching.waking = false;
			});
		};
		const watcher = watch(folderOf(sessionId), (_, name) => {
			if (name === WAKE_FILE) woken();
		});
		watcher.unref();
		watcher.on("error", report);
		const sleeper: Sleeper = {
			wake: watcher,
			gone: new AbortController(),
			woken,
			steered,
		};
		sleepers.set(sessionId, sleeper);
		// One written between its park and this watch.
		woken();
		const steers = options.steers;
		if (steers && sleepers.get(sessionId) === sleeper)
			sleeper.steers = watchWakingSteers({
				root: steers.root,
				addresses: steers.addressesOf(sessionId),
				waking: steered,
				report,
			});
		// The calls its park carried wake it through its file once they end.
		if (sleepers.get(sessionId) === sleeper)
			sleeper.calls = watchCarriedCalls({
				folder: folderOf(sessionId),
				wakeFile: file,
				...(held ? { unrecorded: held } : {}),
				...(options.now ? { now: options.now } : {}),
				// No wake file, no wake through it: ask straight, as doubt wakes.
				unwritten: () => {
					wake(sessionId).catch(() => {
						// Reported as it failed; the next failed write asks again.
					});
				},
				...(options.callRuns ? { runs: options.callRuns } : {}),
				...(options.lookEveryMs === undefined
					? {}
					: { lookEveryMs: options.lookEveryMs }),
				...(options.wakeAgainMs === undefined
					? {}
					: { wakeAgainMs: options.wakeAgainMs }),
				report,
				ended: (calls) =>
					options.said?.(
						calls === 0
							? `${sessionId}: the record of the bash calls its park carried can't be read; waking it`
							: `${sessionId}: the ${calls} bash call(s) its park carried ended; waking it`,
					),
			});
	}

	function wake(sessionId: string): Promise<void> {
		const parked = settling.get(sessionId);
		if (parked)
			return new Promise((resolve, reject) => {
				parked.asked.push({ resolve, reject });
			});
		const asking = options.asking();
		if (!asking) {
			const error = new Error(
				`Nothing can wake parked conversation ${sessionId}`,
			);
			report(error);
			return Promise.reject(error);
		}
		return asking(sessionId).catch((error: unknown) => {
			report(error);
			throw error;
		});
	}

	async function park(sessionId: string, asked: Settling["asked"]) {
		let wakeAtOnce = false;
		let watched = false;
		try {
			// Only what this park carries is watched, never a record an
			// earlier one left.
			try {
				forgetCarriedCalls(folderOf(sessionId));
			} catch (error) {
				// The park goes on: a record left is read as ended calls, which
				// wakes it at once, at each park until the record can go, where
				// stopping here would leave it awake with its watch believing it
				// parked. Holding parks while it stays is a follow-up (#1981 F64).
				report(error);
			}
			unrecorded.delete(sessionId);
			stopping.add(sessionId);
			try {
				await options.stop(
					sessionId,
					PARKED,
					(options.carries?.() ?? false) && mayCarry(sessionId),
				);
			} finally {
				stopping.delete(sessionId);
			}
			const held = unrecorded.get(sessionId);
			unrecorded.delete(sessionId);
			options.parked?.(sessionId);
			// Calls with no record wake it through its file, held as any wake
			// is while the host drains, and asked again until it runs.
			watchWake(sessionId, held);
			watched = true;
		} catch (error) {
			// Stopped but unwatched, only a viewer or an attach wakes it; not
			// stopped, it stays held as a failed close leaves it. Either way,
			// calls it carried would end with nobody to wake it: it wakes.
			report(error);
			wakeAtOnce = !watched && carriedSome(sessionId);
			unrecorded.delete(sessionId);
		} finally {
			settling.delete(sessionId);
		}
		// A key or a message while it parked asked for it before it could
		// wake; calls carried with nobody watching would wake it never.
		if (asked.length > 0 || wakeAtOnce)
			wake(sessionId).then(
				() => {
					for (const one of asked) one.resolve();
				},
				(error: unknown) => {
					for (const one of asked) one.reject(error);
				},
			);
	}

	// Whether its park carried calls, in a record or none it could write;
	// a record that can't be read counts, since it may name some.
	function carriedSome(sessionId: string): boolean {
		if (unrecorded.has(sessionId)) return true;
		try {
			return carriedCalls(folderOf(sessionId)).length > 0;
		} catch {
			// Unreadable: it may name calls, and only waking settles that.
			return true;
		}
	}

	return {
		wakeFile,
		mayCarry,
		watches: (sessionId) => sleepers.has(sessionId),
		running(sessionId) {
			rmSync(wakeFile(sessionId), { force: true });
			clearRefusedWake(wakeFile(sessionId));
			// What its park carried stays watched until it really runs (`ran`):
			// a start that fails leaves it parked, with nobody else to wake it.
		},
		ran(sessionId) {
			try {
				forgetCarriedCalls(folderOf(sessionId));
			} catch (error) {
				// It runs all the same; a record left is read as ended calls.
				report(error);
			}
		},
		hears(sessionId, bus) {
			return hearParkCarry(
				bus,
				() => stopping.has(sessionId),
				(calls) => {
					try {
						mkdirSync(folderOf(sessionId), { recursive: true });
						keepCarriedCalls(folderOf(sessionId), calls);
						options.said?.(
							`${sessionId}: its park carries ${calls.length} bash call(s)`,
						);
					} catch (error) {
						// Unwritten, nothing would wake it as they end: it wakes as
						// soon as it parks, and carries none for a while, so it holds
						// them awake as before parks carried rather than park again.
						unrecorded.set(sessionId, [
							...(unrecorded.get(sessionId) ?? []),
							...calls,
						]);
						uncarried.set(sessionId, now() + UNRECORDED_HOLDS_MS);
						report(error);
					}
				},
			);
		},
		park(sessionId) {
			const asked: Settling["asked"] = [];
			const done = park(sessionId, asked);
			settling.set(sessionId, { done, asked });
			return done;
		},
		rests: watchWake,
		wake,
		settled: (sessionId) => settling.get(sessionId)?.done ?? Promise.resolve(),
		unwatch: forget,
		closed(sessionId, forGood) {
			forget(sessionId);
			uncarried.delete(sessionId);
			try {
				if (forGood) stopCarriedCalls(folderOf(sessionId));
				else forgetCarriedCalls(folderOf(sessionId));
			} catch (error) {
				// The close goes on; what follows it in the engine still runs.
				report(error);
			}
		},
		release() {
			through = false;
			wakeHeld();
		},
		letThrough(on) {
			if (!on) {
				through = false;
				return undefined;
			}
			if (!holding()) return undefined;
			through = true;
			return wakeHeld();
		},
	};

	// Wake each one asked for through its file or a steer while wakes were held, answering how many.
	function wakeHeld(): number {
		let woken = 0;
		for (const sleeper of [...sleepers.values()]) {
			if (sleeper.woken?.()) {
				woken++;
				continue;
			}
			const steer = sleeper.heldSteer;
			if (steer === undefined) continue;
			sleeper.steered?.(steer);
			woken++;
		}
		return woken;
	}
}
