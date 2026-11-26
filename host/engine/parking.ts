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
 * What the stop says it carried is not all a park watches. A call the
 * conversation recorded as it ran (lib/internal/shell/kept-jobs.ts) that
 * still runs is watched too: on 26 November at 00:25 a roll parked
 * 15277F02 while its `devx ci drill` ran, its stop saying no carry,
 * and the call ran on unwatched, its result waiting half an hour for
 * the park's own wake. The conversation takes such a call up from its
 * record as it resumes, as after a kill.
 *
 * While the host drains for a restart, or its code is stale and no
 * window views the conversation (`holding`), a wake through the file or a
 * steer is held: the file stays on disk and the steer in its inbox, so a
 * conversation parked to let the host restart, or to roll onto new code,
 * stays parked. Lifting the drain (`release`) wakes each one asked for
 * meanwhile that is held no more, and the next host's `rests` reads the
 * file left for it. A viewer typing or a window opening is never held.
 * Since a window keeps a stale child running, one viewed is woken here.
 * `holds` says whether a wake would be held now, so a run steps off
 * mid-way only where it goes on in the next start.
 *
 * A drain holds them only until its restart passes the settle ceiling
 * (`letThrough`): from then the host waits for a gap, which background
 * work can put off for hours. From 05:02 on 17 November 13 parked
 * sessions sat on unread wakes that way, questions to them unheard for
 * 1.5 to 3.5 h. Past it, each one held is woken and the rest go through
 * at once, while the drain itself stays for the gap: one woken parks
 * again as soon as it is idle. As the restart comes, or the host stops,
 * they are held again, so one written then waits for the next host.
 *
 * A wake file is read and removed off the thread, as a wake lands at any
 * moment on the loop every conversation the host serves shares. So
 * whether one waits while held is known only once its read comes back:
 * the count `letThrough` answers is of the wakes and steers seen held,
 * and a wake written but not yet seen is still woken as it lifts.
 */
import { type FSWatcher, mkdirSync, rmSync, watch } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
	clearRefusedWake,
	type RefusedWake,
	takeBackRefusedWakeOff,
	wakeAskedBy,
	writeRefusedWakeOff,
} from "../../lib/internal/session/refused-wake.ts";
import type { CarriedShell } from "../../lib/internal/shell/carried.ts";
import { recordedKeptJobs } from "../../lib/internal/shell/kept-jobs.ts";
import { type SteerWatch, watchWakingSteers } from "../../lib/mesh/parked.ts";
import {
	callRuns,
	carriedCalls,
	forgetCarriedCalls,
	hearParkCarry,
	keepCarriedCalls,
	stopCarriedCalls,
	watchCarriedCalls,
} from "./parked-calls.ts";

/** The file inside a conversation's folder that, once written, wakes it from a park. */
const WAKE_FILE = "wake";

/** The bash calls `sessionId` recorded as they ran, from the kept folder. */
async function recordedCallsOf(
	sessionId: string,
): Promise<readonly CarriedShell[]> {
	return (await recordedKeptJobs(sessionId)).map((job) => job.work);
}

/**
 * What a wake file holds, read off the thread: nothing where there is
 * none, and an empty write where it is there but can't be read, since
 * anything written wakes.
 */
async function readWritten(file: string): Promise<string | undefined> {
	try {
		return await readFile(file, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return undefined;
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

/**
 * How long after its watch starts a wake file is looked at once more. A
 * Mac's watch can miss a write in its first moments: on 24 November
 * 3 of 500 writes made 0 to 10 ms after the watch began were never
 * heard, and none of 400 made 50 or 200 ms after, nor any late.
 */
export const WATCH_STARTS_MS = 250;

/** Watch a conversation's folder, telling `heard` the name of each entry that changes. */
export type FolderWatch = (
	folder: string,
	heard: (name: string | null) => void,
) => FSWatcher;

const watchFolder: FolderWatch = (folder, heard) =>
	watch(folder, (_, name) => heard(name));

/** A park whose stop threw before it began, so its conversation runs on as it was. */
export interface RanOn {
	readonly error: unknown;
}

/** What parks and wakes the engine's conversations. */
export interface Parking {
	/** Where a sender wakes this conversation once it parks. */
	wakeFile(sessionId: string): string;
	/** It runs now: a wake left from an earlier park would wake its next at once. */
	running(sessionId: string): void;
	/**
	 * Park it, then watch for its wake; a wake asked meanwhile wakes it
	 * once parked. Answers what refused it when its stop threw before it
	 * began, so it runs on as it was, and nothing once it stopped or rests
	 * owed its stop.
	 */
	park(sessionId: string): Promise<RanOn | undefined>;
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
	/**
	 * Once a park of it under way has settled, at once when none is. One
	 * whose stop failed is owed it: each call tries the stop again, once at
	 * a time, and settles as that try does, never rejecting, so a wake, an
	 * attach or a close goes on to find it parked or still held.
	 */
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
	 * Whether a wake of it asked now would be held for the next start,
	 * rather than wake it here: `holding` says so, and no drain's restart
	 * has passed its ceiling.
	 */
	holds(sessionId: string): boolean;
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
	woken?: () => Promise<boolean>;
	/** Its wake file was last seen written while its wake was held. */
	wakeHeld?: boolean;
	/** A look at its wake file under way, which a second stir waits behind. */
	looking?: Promise<boolean>;
	/** It stirred during a look, so it looks again once that ends. */
	stirred?: boolean;
	/** Wake it for this steer. */
	steered?: (steer: string) => void;
	/** A steer that landed while the host held its wakes. */
	heldSteer?: string;
	/** Stops looking at the bash calls its park carried. */
	calls?: () => void;
	/** The look once its watch's first moments pass. */
	started?: ReturnType<typeof setTimeout>;
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
	readonly done: Promise<unknown>;
	readonly asked: { resolve(): void; reject(error: unknown): void }[];
}

/** A stop a failed park owes: whether it carries, and the try under way. */
interface Owed {
	readonly carrying: boolean;
	trying?: Promise<void>;
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
	/**
	 * Whether this one's wakes through the file and steers are held now: as
	 * the host drains, or as its code is stale and no window views it.
	 */
	readonly holding?: (sessionId: string) => boolean;
	/** Whether the host drains for a restart, whose ceiling `letThrough` passes. */
	readonly draining?: () => boolean;
	/**
	 * Whether the host keeps a carried bash call alive through a stop, so a
	 * park carries them (carried-shells.ts); none, it carries none.
	 */
	readonly carries?: () => boolean;
	/** Whether a carried call still runs; its shell, read from the machine, by default. */
	readonly callRuns?: (work: CarriedShell) => boolean | Promise<boolean>;
	/**
	 * The bash calls a conversation recorded as they ran, whoever holds
	 * them; read from the kept folder, off the thread, by default.
	 */
	readonly recorded?: (sessionId: string) => Promise<readonly CarriedShell[]>;
	/** How often a parked conversation's carried calls are looked at; CALLS_LOOK_MS by default. */
	readonly lookEveryMs?: number;
	/** How long before a wake for ended calls is asked again; CALLS_WAKE_AGAIN_MS by default. */
	readonly wakeAgainMs?: number;
	/** How a parked conversation's folder is watched; node's `fs.watch` by default. */
	readonly watch?: FolderWatch;
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
	const holding = (sessionId: string) =>
		!through && options.holding?.(sessionId) === true;
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
	// Conversations whose park's stop failed while the host still holds them,
	// each watched as a parked one is and owed that stop: whether it carries,
	// as the first try did, and the try at it under way, if any.
	const owed = new Map<string, Owed>();
	// Conversations whose stop for a park told a carry, recorded or not.
	const told = new Set<string>();
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
		if (sleeper?.started) clearTimeout(sleeper.started);
		sleepers.delete(sessionId);
	}

	// Once it runs or is closed, no refusal of a wake says anything true.
	function forget(sessionId: string): void {
		owed.delete(sessionId);
		told.delete(sessionId);
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
		// Whether it asked a wake, so a release asks no second for a held
		// steer. `holding` is asked only once a wake is there, so it says one
		// landed, as a steer's does.
		const lookAt = async (watching: Sleeper): Promise<boolean> => {
			const written = await readWritten(file);
			if (sleepers.get(sessionId) !== watching) return false;
			if (written === undefined || holding(sessionId)) {
				watching.wakeHeld = written !== undefined;
				return false;
			}
			watching.wakeHeld = false;
			try {
				await rm(file, { force: true });
			} catch (error) {
				// Asked all the same: a wake left on disk wakes it again at most.
				report(error);
			}
			// Resumed or closed meanwhile, it needs no wake.
			if (sleepers.get(sessionId) !== watching) return false;
			watching.heldSteer = undefined;
			void ask(watching, wakeAskedBy(written));
			return true;
		};
		// One look at a time, so a wake's several events ask it once; one
		// stirring during a look looks again once it ends, for a wake written
		// after that look's read. Each answers once its looks again are done
		// too, so a release asks a held steer only where no look asked a wake.
		const woken = (): Promise<boolean> => {
			const watching = sleepers.get(sessionId);
			if (!watching) return Promise.resolve(false);
			if (watching.looking) {
				watching.stirred = true;
				return watching.looking;
			}
			const looking = lookAt(watching)
				.catch((error: unknown) => {
					report(error);
					return false;
				})
				.then(async (asked) => {
					watching.looking = undefined;
					if (!watching.stirred) return asked;
					watching.stirred = false;
					return (await woken()) || asked;
				});
			watching.looking = looking;
			return looking;
		};
		// A steer landing while its wake is asked would ask the same wake again.
		const steered = (steer: string) => {
			const watching = sleepers.get(sessionId);
			if (!watching || watching.waking) return;
			if (holding(sessionId)) {
				watching.heldSteer = steer;
				return;
			}
			watching.heldSteer = undefined;
			watching.waking = true;
			void ask(watching, `steer-${steer}`, () => {
				watching.waking = false;
			});
		};
		const watcher = (options.watch ?? watchFolder)(
			folderOf(sessionId),
			(name) => {
				if (name === WAKE_FILE) void woken();
			},
		);
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
		void woken();
		// And one written as the watch started, which a Mac's can miss: a
		// single look, since no write later than its first moments went
		// unheard. Unref'd, as a host stopping needs no look.
		sleeper.started = setTimeout(() => {
			sleeper.started = undefined;
			if (sleepers.get(sessionId) === sleeper) void woken();
		}, WATCH_STARTS_MS);
		sleeper.started.unref();
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

	async function park(
		sessionId: string,
		asked: Settling["asked"],
	): Promise<RanOn | undefined> {
		let ranOn: RanOn | undefined;
		let wakeAtOnce = false;
		let watched = false;
		let began = false;
		let stopped = false;
		let carrying = false;
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
				carrying = (options.carries?.() ?? false) && mayCarry(sessionId);
				const stop = options.stop(sessionId, PARKED, carrying);
				began = true;
				await stop;
				stopped = true;
			} finally {
				stopping.delete(sessionId);
			}
			if (carrying) await keepRecorded(sessionId);
			const held = unrecorded.get(sessionId);
			unrecorded.delete(sessionId);
			options.parked?.(sessionId);
			// Calls with no record wake it through its file, held as any wake
			// is while the host drains, and asked again until it runs.
			watchWake(sessionId, held);
			watched = true;
		} catch (error) {
			report(error);
			// Not stopped, it stays held as a failed close leaves it, its
			// cleanup perhaps half run: it rests as a parked one does, its
			// wakes and the calls it carried watched, and is owed its stop,
			// which `settled` tries again before a wake, an attach or a close
			// (#2099 F108). Undoing the stop instead would run it on what a
			// half run cleanup left. One whose stop threw before it began was
			// never stopped at all, and runs on as it was.
			if (began && !stopped) watched = restOwed(sessionId, carrying);
			else if (!began) ranOn = { error };
			// Stopped but unwatched, only a viewer or an attach wakes it, and
			// calls it carried would end with nobody to wake it: it wakes.
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
		return ranOn;
	}

	// Add to what its park carried each call it recorded as it ran that
	// still runs and its stop never said, so its end wakes it. Never
	// throws: what can't be read parks it on what its stop said.
	async function keepRecorded(sessionId: string): Promise<void> {
		const folder = folderOf(sessionId);
		const untold: CarriedShell[] = [];
		try {
			const recorded = await (options.recorded ?? recordedCallsOf)(sessionId);
			if (recorded.length === 0) return;
			const known = new Set(
				[...carriedCalls(folder), ...(unrecorded.get(sessionId) ?? [])].map(
					(work) => work.keep,
				),
			);
			const runs = options.callRuns ?? callRuns;
			for (const work of recorded) {
				if (known.has(work.keep) || !(await runs(work))) continue;
				known.add(work.keep);
				untold.push(work);
			}
		} catch (error) {
			report(error);
			return;
		}
		if (untold.length === 0) return;
		try {
			mkdirSync(folder, { recursive: true });
			keepCarriedCalls(folder, untold);
		} catch (error) {
			// Unwritten, nothing would wake it as they end: it wakes once parked.
			unrecorded.set(sessionId, [
				...(unrecorded.get(sessionId) ?? []),
				...untold,
			]);
			report(error);
		}
		options.said?.(
			`${sessionId}: its park carries ${untold.length} bash call(s) it recorded but never said it carried`,
		);
	}

	// Rest one whose park's stop failed, owed that stop, answering whether
	// its wake is watched.
	function restOwed(sessionId: string, carrying: boolean): boolean {
		const held = unrecorded.get(sessionId);
		owed.set(sessionId, { carrying });
		try {
			watchWake(sessionId, held);
			return true;
		} catch (error) {
			report(error);
			return false;
		}
	}

	// Try once more the stop a failed park owes it, one try at a time, never
	// rejecting. It carries as the first try did, since the conversation
	// keeps what that try told it of a restart, and what it carries is the
	// park's to record and watch, as the first try's would have been. A try
	// that fails is reported and stays owed.
	function stopOwed(sessionId: string): Promise<void> {
		const owing = owed.get(sessionId);
		if (!owing) return Promise.resolve();
		if (owing.trying) return owing.trying;
		const entry: Owed = { carrying: owing.carrying };
		const ours = () => owed.get(sessionId) === entry;
		told.delete(sessionId);
		unrecorded.delete(sessionId);
		stopping.add(sessionId);
		let stop: Promise<void>;
		try {
			stop = options.stop(sessionId, PARKED, owing.carrying);
		} catch (error) {
			stop = Promise.reject(error);
		}
		entry.trying = stop
			.finally(() => stopping.delete(sessionId))
			.then(
				() => {
					// Run or closed meanwhile, nothing is owed it any more.
					if (!ours()) return;
					owed.delete(sessionId);
					parkedOnRetry(sessionId);
				},
				(error: unknown) => {
					report(error);
					if (ours()) owed.set(sessionId, { carrying: owing.carrying });
				},
			);
		owed.set(sessionId, entry);
		return entry.trying;
	}

	// Parked at last by a stop tried again: calls that try carried are
	// watched as a park's are, which the watch since the park never read.
	function parkedOnRetry(sessionId: string): void {
		const held = unrecorded.get(sessionId);
		unrecorded.delete(sessionId);
		try {
			options.parked?.(sessionId);
		} catch (error) {
			// Parked all the same, its wake watched since the park.
			report(error);
		}
		if (!told.delete(sessionId)) return;
		try {
			watchWake(sessionId, held);
		} catch (error) {
			// Calls carried with nobody watching would wake it never: it wakes.
			report(error);
			wake(sessionId).catch(() => {
				// Reported as it failed; a wake from a viewer asks again.
			});
		}
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
			// It runs, so the stop a failed park owed it is no longer owed.
			owed.delete(sessionId);
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
					told.add(sessionId);
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
		// A park still under way may fail its stop, which is owed once it settles.
		settled: (sessionId) => {
			const parking = settling.get(sessionId);
			return parking
				? parking.done.then(() => stopOwed(sessionId))
				: stopOwed(sessionId);
		},
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
		holds: holding,
		release() {
			through = false;
			wakeHeld();
		},
		letThrough(on) {
			if (!on) {
				through = false;
				return undefined;
			}
			if (through || options.draining?.() !== true) return undefined;
			through = true;
			return wakeHeld();
		},
	};

	/**
	 * Wake each one asked for through its file or a steer while wakes were
	 * held, answering how many were seen held. Every wake file is looked at
	 * again, off the thread, so one written but not yet seen wakes too; a
	 * held steer is asked only where its file asked no wake.
	 */
	function wakeHeld(): number {
		let woken = 0;
		for (const sleeper of [...sleepers.values()]) {
			const steer = sleeper.heldSteer;
			if (sleeper.wakeHeld === true || steer !== undefined) woken++;
			const looking = sleeper.woken?.() ?? Promise.resolve(false);
			void looking.then((asked) => {
				if (asked || steer === undefined) return;
				if (sleeper.heldSteer !== steer) return;
				sleeper.steered?.(steer);
			});
		}
		return woken;
	}
}
