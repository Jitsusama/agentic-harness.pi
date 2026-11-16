/**
 * Wakes side by side, a window's first: a host resumes a few waking
 * conversations at once, and a person at a window on one goes ahead of
 * them all. Resumed one at a time (#1658, reverted), a burst of 20 ended
 * about twice as late as resumed together, so a few at once keep most of
 * the overlap. A window's resume never waits for a place, and no other
 * wake begins while one runs, so the conversation someone is looking at
 * shares the thread only with those already resuming. A window asking for
 * a conversation whose own wake waits, or already resumes, takes that wake
 * in as its own.
 *
 * Each resume holds back the others for at most its longest: past that
 * it counts against neither the places nor the windows, and the journal
 * says which, and again when it ends. So a resume that never ends costs
 * those behind it one longest, not the host's life, and a deep queue
 * still goes in a few at a time. Once the host stops, the wakes still
 * waiting are refused rather than resumed only to be parked.
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
	/** Run one wake's resume once it has a place, a window's at once. */
	inPlace<T>(
		asker: WakeAsker,
		sessionId: string,
		resume: () => Promise<T>,
	): Promise<T>;
	/**
	 * A window asks for `sessionId`: its wake resuming, waiting for a place,
	 * or the next to come, counts as a window's. Call what it answers once
	 * the window's own wake has settled.
	 */
	hurry(sessionId: string): () => void;
	/**
	 * The host stops: refuse with `why` every wake still waiting for a
	 * place, and any asked after, leaving those resuming to end.
	 */
	close(why: Error): void;
}

/** A wake waiting for its place. */
interface Waiting {
	readonly sessionId: string;
	enter(as: WakeAsker): void;
	refuse(why: Error): void;
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
	// How to count each conversation's resume under way as a window's; a
	// conversation's wakes take turns, so it has one at most.
	const promotions = new Map<string, () => void>();
	let placed = 0;
	let windows = 0;
	let closed: Error | undefined;

	const free = (): boolean => windows === 0 && placed < places;
	const seconds = (ms: number): string => (ms / MS_PER_SECOND).toFixed(1);

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
	// has run its longest; answers how it ends.
	function occupy(asker: WakeAsker, sessionId: string): () => void {
		let as = asker;
		if (as === "window") windows += 1;
		else placed += 1;
		const began = Date.now();
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
			options.say?.(
				`The wake of ${sessionId} is still resuming after ${seconds(longestMs)} s; it holds back no other wake from now`,
			);
			uncount();
		}, longestMs);
		longest.unref?.();
		return () => {
			clearTimeout(longest);
			if (promotions.get(sessionId) === promote) promotions.delete(sessionId);
			if (counted) uncount();
			else if (lapsed)
				options.say?.(
					`The wake of ${sessionId} resumed after ${seconds(Date.now() - began)} s`,
				);
		};
	}

	function placeFor(sessionId: string): Promise<() => void> {
		return new Promise((resolve, reject) => {
			waiting.push({
				sessionId,
				enter: (as) => resolve(occupy(as, sessionId)),
				refuse: reject,
			});
		});
	}

	async function inPlace<T>(
		asker: WakeAsker,
		sessionId: string,
		resume: () => Promise<T>,
	): Promise<T> {
		if (closed) throw closed;
		const as = hurried.has(sessionId) ? "window" : asker;
		const ended =
			as === "window" || (free() && waiting.length === 0)
				? occupy(as, sessionId)
				: await placeFor(sessionId);
		try {
			return await resume();
		} finally {
			ended();
		}
	}

	function hurry(sessionId: string): () => void {
		hurried.set(sessionId, (hurried.get(sessionId) ?? 0) + 1);
		const index = waiting.findIndex((one) => one.sessionId === sessionId);
		if (index !== -1) waiting.splice(index, 1)[0]?.enter("window");
		else promotions.get(sessionId)?.();
		let done = false;
		return () => {
			if (done) return;
			done = true;
			const left = (hurried.get(sessionId) ?? 1) - 1;
			if (left > 0) hurried.set(sessionId, left);
			else hurried.delete(sessionId);
		};
	}

	function close(why: Error): void {
		closed = why;
		for (const one of waiting.splice(0)) one.refuse(why);
	}

	return { inPlace, hurry, close };
}
