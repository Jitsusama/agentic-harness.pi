/**
 * Wakes side by side, a window's first: a host resumes a few waking
 * conversations at once, and a person opening a window on one goes
 * ahead of them all. Resumed one at a time (#1658, reverted), a burst of
 * 20 ended about twice as late as resumed together, so resumes overlap
 * more than they contend for the host's one thread. A window's resume
 * never waits for a place, and no other wake begins while one runs, so
 * the conversation someone is looking at shares the thread only with
 * those already resuming. A wake waits for a place at most its longest,
 * then resumes anyway, so resumes that never end hold up none of the
 * others for good.
 */

/** How many wakes, other than a window's, resume at once. */
export const WAKE_PLACES = 4;

/** How long a wake waits for a place before it resumes anyway. */
export const WAKE_LONGEST_MS = 20_000;

/**
 * Who asked for a wake: a person opening a window on the conversation, or
 * anything else (a message to it, its wake file, a key typed to it).
 */
export type WakeAsker = "window" | "other";

/** The host's wakes, each resumed once it has its place. */
export interface WakePlaces {
	/** Run one wake's resume once it has a place, a window's at once. */
	inPlace<T>(asker: WakeAsker, resume: () => Promise<T>): Promise<T>;
}

/** Wakes resumed `places` at a time, a window's at once and before the rest. */
export function wakePlaces(
	places: number = WAKE_PLACES,
	longestMs: number = WAKE_LONGEST_MS,
): WakePlaces {
	// Each waiting wake's way in, taking its place as it goes.
	const waiting: Array<() => void> = [];
	let placed = 0;
	let windows = 0;

	const free = (): boolean => windows === 0 && placed < places;

	// Let in as many waiting wakes, first asked first, as there are places,
	// none while a window's resumes.
	function handOn(): void {
		while (free()) {
			const next = waiting.shift();
			if (!next) return;
			next();
		}
	}

	async function inPlace<T>(
		asker: WakeAsker,
		resume: () => Promise<T>,
	): Promise<T> {
		if (asker === "window") {
			windows += 1;
			try {
				return await resume();
			} finally {
				windows -= 1;
				handOn();
			}
		}
		let holds = false;
		if (free() && waiting.length === 0) {
			placed += 1;
			holds = true;
		} else holds = await placeOrLongest();
		try {
			return await resume();
		} finally {
			if (holds) {
				placed -= 1;
				handOn();
			}
		}
	}

	// Whether this wake got a place, rather than waiting its longest.
	function placeOrLongest(): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const enter = (): void => {
				clearTimeout(timer);
				placed += 1;
				resolve(true);
			};
			waiting.push(enter);
			timer = setTimeout(() => {
				const index = waiting.indexOf(enter);
				if (index !== -1) waiting.splice(index, 1);
				resolve(false);
			}, longestMs);
			timer.unref?.();
		});
	}

	return { inPlace };
}
