/**
 * Wakes in turn: a host resumes one waking conversation at a time. Every
 * conversation a host holds shares its one thread, so a burst of wakes
 * resumed together finishes each of them late, the window someone opened
 * among them; one at a time, each is ready as soon as its own resume ends,
 * and a window's attach goes ahead of every wake still waiting. A wake
 * waits behind the one ahead at most its longest, then resumes beside it,
 * so a resume that never ends holds up none of the others for good.
 */

/** How long a wake waits behind the one resuming before it resumes anyway. */
export const WAKE_TURN_MOST_MS = 20_000;

/**
 * Who asked for a wake: a person opening a window on the conversation, or
 * anything else (a message to it, its wake file, a key typed to it).
 */
export type WakeAsker = "window" | "other";

/** The host's wakes, each run in its turn. */
export interface WakeTurns {
	/** Run one wake's resume once its turn comes, a window's before the rest. */
	inTurn<T>(asker: WakeAsker, resume: () => Promise<T>): Promise<T>;
}

interface Waiting {
	readonly asker: WakeAsker;
	readonly go: () => void;
}

/** Wakes taken one at a time, none waiting longer than `mostMs` behind another. */
export function wakeTurns(mostMs: number = WAKE_TURN_MOST_MS): WakeTurns {
	const waiting: Waiting[] = [];
	let resuming = false;

	// Hand the turn to the next, the first window's else the first asked,
	// or let it go when none waits.
	function handOn(): void {
		const index = waiting.findIndex((one) => one.asker === "window");
		const [chosen] = waiting.splice(index === -1 ? 0 : index, 1);
		if (chosen) chosen.go();
		else resuming = false;
	}

	async function inTurn<T>(
		asker: WakeAsker,
		resume: () => Promise<T>,
	): Promise<T> {
		// Holding the turn: the one resuming hands it on as it ends, so no
		// wake asked in between takes it too. A wake that went on having
		// waited its longest holds none.
		let holds = true;
		if (resuming) holds = await turnOrLongest(asker);
		else resuming = true;
		try {
			return await resume();
		} finally {
			if (holds) handOn();
		}
	}

	// Whether this wake got its turn, rather than waiting its longest.
	function turnOrLongest(asker: WakeAsker): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const one: Waiting = {
				asker,
				go: () => {
					clearTimeout(timer);
					resolve(true);
				},
			};
			waiting.push(one);
			timer = setTimeout(() => {
				const index = waiting.indexOf(one);
				if (index !== -1) waiting.splice(index, 1);
				resolve(false);
			}, mostMs);
			timer.unref?.();
		});
	}

	return { inTurn };
}
