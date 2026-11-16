/**
 * Wakes side by side, a window's first: a host resumes a few waking
 * conversations at once, and a person at a window on one goes ahead of
 * them all. Resumed one at a time (#1658, reverted), a burst of 20 ended
 * about twice as late as resumed together, so a few at once keep most of
 * the overlap. A window's resume never waits for a place, and no other
 * wake begins while one runs, so the conversation someone is looking at
 * shares the thread only with those already resuming. A window asking for
 * a conversation whose own wake already waits takes that wake in as its
 * own.
 *
 * Each resume holds back the others for at most its longest: past that
 * it counts against neither the places nor the windows, and the journal
 * says which. So a resume that never ends costs those behind it one
 * longest, not the host's life, and a deep queue still goes in a few at a
 * time.
 */

/** How many wakes, other than a window's, resume at once. */
export const WAKE_PLACES = 4;

/** How long one resume holds back the others before it counts no more. */
export const WAKE_LONGEST_MS = 20_000;

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
	 * A window asks for `sessionId`: its wake waiting for a place, or the
	 * next to come, goes in as a window's. Call what it answers once the
	 * window's own wake has settled.
	 */
	hurry(sessionId: string): () => void;
}

/** A wake waiting for its place. */
interface Waiting {
	readonly sessionId: string;
	enter(as: WakeAsker): void;
}

/** Wakes resumed `places` at a time, a window's at once and before the rest. */
export function wakePlaces(
	options: {
		places?: number;
		longestMs?: number;
		/** Writes a line to the host's journal, as each resume that ran its longest. */
		say?: (line: string) => void;
	} = {},
): WakePlaces {
	const places = options.places ?? WAKE_PLACES;
	const longestMs = options.longestMs ?? WAKE_LONGEST_MS;
	const waiting: Waiting[] = [];
	// How many windows ask for each conversation, and so hurry its wake.
	const hurried = new Map<string, number>();
	let placed = 0;
	let windows = 0;

	const free = (): boolean => windows === 0 && placed < places;

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
	// has run its longest; answers how it gives its count back.
	function occupy(as: WakeAsker, sessionId: string): () => void {
		if (as === "window") windows += 1;
		else placed += 1;
		let counted = true;
		const leave = (): void => {
			if (!counted) return;
			counted = false;
			clearTimeout(longest);
			if (as === "window") windows -= 1;
			else placed -= 1;
			handOn();
		};
		// The longest one resume may hold back the rest: past it, a resume
		// that may never end lets them on rather than closing their places.
		const longest = setTimeout(() => {
			options.say?.(
				`The wake of ${sessionId} has resumed for ${longestMs / 1000} s; it holds back no other wake from now`,
			);
			leave();
		}, longestMs);
		longest.unref?.();
		return leave;
	}

	function placeFor(sessionId: string): Promise<() => void> {
		return new Promise((resolve) => {
			waiting.push({
				sessionId,
				enter: (as) => resolve(occupy(as, sessionId)),
			});
		});
	}

	async function inPlace<T>(
		asker: WakeAsker,
		sessionId: string,
		resume: () => Promise<T>,
	): Promise<T> {
		const as = hurried.has(sessionId) ? "window" : asker;
		const leave =
			as === "window" || (free() && waiting.length === 0)
				? occupy(as, sessionId)
				: await placeFor(sessionId);
		try {
			return await resume();
		} finally {
			leave();
		}
	}

	function hurry(sessionId: string): () => void {
		hurried.set(sessionId, (hurried.get(sessionId) ?? 0) + 1);
		const index = waiting.findIndex((one) => one.sessionId === sessionId);
		if (index !== -1) waiting.splice(index, 1)[0]?.enter("window");
		let done = false;
		return () => {
			if (done) return;
			done = true;
			const left = (hurried.get(sessionId) ?? 1) - 1;
			if (left > 0) hurried.set(sessionId, left);
			else hurried.delete(sessionId);
		};
	}

	return { inPlace, hurry };
}
