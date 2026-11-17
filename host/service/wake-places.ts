/**
 * Wakes side by side, a window's first: a host resumes a few waking
 * conversations at once, and a person at a window on one goes ahead of
 * them all. Resumed one at a time (#1658, reverted), a burst of 20 ended
 * about twice as late as resumed together, so a few at once keep most of
 * the overlap. A window's resume never waits for a place, and no other
 * wake begins while one runs, so the conversation someone is looking at
 * shares the thread only with those already resuming. A window asking for
 * a conversation whose own wake waits, or already resumes, takes that wake
 * in as its own. A close or release of one whose wake waits lets that wake
 * go unresumed, since nobody is looking at a conversation being closed:
 * it lands at once, and the queue goes on. A window's wake is never let
 * go, since the person asked first; and a close that fails says it let a
 * wake go, so its caller can ask that wake again.
 *
 * Each resume holds back the others for at most its longest: past that
 * it counts against neither the places nor the windows, and the journal
 * says which, and again when it ends or fails. So a resume that never
 * ends costs those behind it one longest, not the host's life, and a deep
 * queue still goes in a few at a time; a promoted resume keeps the clock
 * it began with, so the bound holds. Once the host stops, every wake
 * still waiting goes in at once, as before places: its wake file is
 * already taken, so refusing it would lose it, and the stop waits for one
 * round of resumes rather than several.
 */

/** How many wakes, other than a window's, resume at once. */
export const WAKE_PLACES = 4;

/** How long one resume holds back the others before it counts no more. */
export const WAKE_LONGEST_MS = 20_000;

/** Milliseconds in a second, for the journal's lines. */
const MS_PER_SECOND = 1000;

/**
 * Who asked for a wake: a person at a window on the conversation (opening
 * it, or typing to it parked), or anything else (a message to it, its
 * wake file).
 */
export type WakeAsker = "window" | "other";

/** The host's wakes, each resumed once it has its place. */
export interface WakePlaces {
	/**
	 * Run one wake's resume once it has a place, a window's at once; one a
	 * close let go answers undefined, never resumed.
	 */
	inPlace<T>(
		asker: WakeAsker,
		sessionId: string,
		resume: () => Promise<T>,
	): Promise<T | undefined>;
	/**
	 * A window asks for `sessionId`: its wake resuming, waiting for a place,
	 * or the next to come, counts as a window's. Call what it answers once
	 * the window's own wake has settled.
	 */
	hurry(sessionId: string): () => void;
	/**
	 * A close or release takes `sessionId`: its wake waiting for a place, or
	 * one still to ask for it, goes unresumed, unless a window asked for it.
	 * A resume under way is left to end. Call what it answers once the close
	 * has settled: it says whether it let any wake go.
	 */
	skip(sessionId: string): () => boolean;
	/** The host stops: every wake waiting goes in now, and any asked after. */
	stopping(): void;
}

/** A wake waiting for its place. */
interface Waiting {
	readonly sessionId: string;
	enter(as: WakeAsker): void;
	/** Let it go unresumed. */
	leave(): void;
}

/** Wakes resumed `places` at a time, a window's at once and before the rest. */
export function wakePlaces(
	options: {
		/** At least one, however few are asked for, so a wake always gets on. */
		places?: number;
		longestMs?: number;
		/** Writes a line to the host's journal, as each resume that ran its longest. */
		say?: (line: string) => void;
	} = {},
): WakePlaces {
	const places = Math.max(1, options.places ?? WAKE_PLACES);
	const longestMs = options.longestMs ?? WAKE_LONGEST_MS;
	const waiting: Waiting[] = [];
	// How many windows ask for each conversation, and so hurry its wake.
	const hurried = new Map<string, number>();
	// The closes taking each conversation, so letting its wake go, each
	// counting the wakes it let go.
	const skipped = new Map<string, Set<{ letGo: number }>>();
	// How to count each conversation's resume under way as a window's; a
	// conversation's wakes take turns, so it has one at most.
	const promotions = new Map<string, () => void>();
	let placed = 0;
	let windows = 0;
	let stopped = false;

	const free = (): boolean => stopped || (windows === 0 && placed < places);
	const seconds = (ms: number): string => (ms / MS_PER_SECOND).toFixed(1);
	const tell = (line: string): void => {
		try {
			options.say?.(line);
		} catch {
			// A journal that fails must not fail the wake it tells of, nor keep
			// its place: the line is lost, the resume's outcome is not.
		}
	};

	// Let in as many waiting wakes, first asked first, as there are places,
	// none while a window's resumes.
	function handOn(): void {
		while (free()) {
			const next = waiting.shift();
			if (!next) return;
			next.enter("other");
		}
	}

	// Count one resume against the windows or the places, until it ends or
	// has run its longest; answers how it ends, failed or not.
	function occupy(
		asker: WakeAsker,
		sessionId: string,
	): (failed: boolean) => void {
		let as = asker;
		if (as === "window") windows += 1;
		else placed += 1;
		// Monotonic, so a suspend or a clock step can't misstate how long.
		const began = performance.now();
		let counted = true;
		let lapsed = false;
		const uncount = (): void => {
			counted = false;
			if (as === "window") windows -= 1;
			else placed -= 1;
			handOn();
		};
		const promote = (): void => {
			if (!counted || as === "window") return;
			as = "window";
			placed -= 1;
			windows += 1;
		};
		promotions.set(sessionId, promote);
		// The longest one resume may hold back the rest: past it, a resume
		// that may never end lets them on rather than closing their places.
		const longest = setTimeout(() => {
			if (!counted) return;
			lapsed = true;
			uncount();
			tell(
				`The wake of ${sessionId} is still resuming after ${seconds(longestMs)} s; it holds back no other wake from now`,
			);
		}, longestMs);
		longest.unref?.();
		return (failed) => {
			clearTimeout(longest);
			if (promotions.get(sessionId) === promote) promotions.delete(sessionId);
			if (counted) uncount();
			else if (lapsed)
				tell(
					`The wake of ${sessionId} ${failed ? "failed" : "resumed"} after ${seconds(performance.now() - began)} s`,
				);
		};
	}

	// Answers how its resume ends once it has a place, or undefined once a
	// close lets it go.
	function placeFor(
		sessionId: string,
	): Promise<((failed: boolean) => void) | undefined> {
		return new Promise((resolve) => {
			waiting.push({
				sessionId,
				enter: (as) => resolve(occupy(as, sessionId)),
				leave: () => resolve(undefined),
			});
		});
	}

	async function inPlace<T>(
		asker: WakeAsker,
		sessionId: string,
		resume: () => Promise<T>,
	): Promise<T | undefined> {
		const as = hurried.has(sessionId) ? "window" : asker;
		if (as === "other" && letGo(sessionId)) return undefined;
		const ended =
			as === "window" || (free() && waiting.length === 0)
				? occupy(as, sessionId)
				: await placeFor(sessionId);
		if (!ended) return undefined;
		let failed = true;
		try {
			const resumed = await resume();
			failed = false;
			return resumed;
		} finally {
			ended(failed);
		}
	}

	// Count one more asking for `sessionId` in `counts`, and answer how to
	// count it out again, once however often called.
	function countIn(counts: Map<string, number>, sessionId: string): () => void {
		counts.set(sessionId, (counts.get(sessionId) ?? 0) + 1);
		let done = false;
		return () => {
			if (done) return;
			done = true;
			const left = (counts.get(sessionId) ?? 1) - 1;
			if (left > 0) counts.set(sessionId, left);
			else counts.delete(sessionId);
		};
	}

	// Take `sessionId`'s wake waiting for a place out of the queue, if any.
	function takeWaiting(sessionId: string): Waiting | undefined {
		const index = waiting.findIndex((one) => one.sessionId === sessionId);
		return index === -1 ? undefined : waiting.splice(index, 1)[0];
	}

	function hurry(sessionId: string): () => void {
		const counted = countIn(hurried, sessionId);
		const queued = takeWaiting(sessionId);
		if (queued) queued.enter("window");
		else promotions.get(sessionId)?.();
		return counted;
	}

	// Count a wake of `sessionId` let go against every close taking it, and
	// answer whether any did.
	function letGo(sessionId: string): boolean {
		const closes = skipped.get(sessionId);
		if (!closes) return false;
		for (const close of closes) close.letGo += 1;
		return true;
	}

	function skip(sessionId: string): () => boolean {
		const close = { letGo: 0 };
		const closes = skipped.get(sessionId) ?? new Set();
		closes.add(close);
		skipped.set(sessionId, closes);
		// A window's wake never waits, so one waiting is nobody's at a window.
		const queued = takeWaiting(sessionId);
		if (queued) {
			letGo(sessionId);
			queued.leave();
		}
		return () => {
			closes.delete(close);
			if (closes.size === 0 && skipped.get(sessionId) === closes)
				skipped.delete(sessionId);
			return close.letGo > 0;
		};
	}

	function stopping(): void {
		stopped = true;
		handOn();
	}

	return { inPlace, hurry, skip, stopping };
}
