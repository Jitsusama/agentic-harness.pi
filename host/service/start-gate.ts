/**
 * The gate every child start passes, whatever asked for it: a start's
 * resume, a wake, an open or an adopt. A host start or a burst of wakes
 * and opens asks for many children at once, and each builds its
 * conversation on the same loaded machine, so all of them together are
 * slow enough to be judged stuck, given up and started again. Only a
 * few are let between their unit's start and their first answer at
 * once; the rest wait their turn, those someone waits on first, and a
 * wait that its caller's time, a host's stop or a give-up ends leaves
 * the queue at once.
 */

/** What a start waits for its turn with. */
export interface StartAsk {
	/** Someone waits on it, as a wake's writer does, so it goes ahead of the rest. */
	readonly ahead: boolean;
	/** When its caller gives up, as a time; never for one nobody bounds. */
	readonly by: number;
	/** Ends its wait, as the host's stop or a give-up does, with the signal's reason. */
	readonly signal: AbortSignal;
	/** The error it is refused with once `by` passes while it waits. */
	late(): Error;
	/**
	 * Moves it ahead once aborted, as someone coming to wait on a start
	 * that nobody waited on when it asked does: a wake for a conversation
	 * a host's start still owes.
	 */
	readonly hurry?: AbortSignal;
}

/** The gate, as the supervisor asks it for a turn. */
export interface StartGate {
	/**
	 * Settle once `ask` may start its child, with what gives its turn back
	 * once its child has answered, failed or been given up; reject when
	 * its wait is ended first, its place in the queue let go.
	 */
	turn(ask: StartAsk): Promise<() => void>;
}

/** One start waiting its turn. */
interface Waiting {
	ahead: boolean;
	go(): void;
}

/** A gate letting `atOnce` starts through at a time. */
export function startGate(atOnce: number): StartGate {
	let running = 0;
	const waiting: Waiting[] = [];

	function given(): () => void {
		running += 1;
		let back = false;
		return () => {
			if (back) return;
			back = true;
			running -= 1;
			letNext();
		};
	}

	/** Queue `one` behind every start already waiting ahead, if it is ahead, else last. */
	function queue(one: Waiting): void {
		const behind = one.ahead ? waiting.findIndex((other) => !other.ahead) : -1;
		if (behind < 0) waiting.push(one);
		else waiting.splice(behind, 0, one);
	}

	function letNext(): void {
		while (running < atOnce) {
			const next = waiting.shift();
			if (!next) return;
			next.go();
		}
	}

	return {
		turn(ask) {
			return new Promise((resolve, reject) => {
				if (ask.signal.aborted) {
					reject(ask.signal.reason);
					return;
				}
				if (running < atOnce && waiting.length === 0) {
					resolve(given());
					return;
				}
				let timer: ReturnType<typeof setTimeout> | undefined;
				const settled = () => {
					if (timer !== undefined) clearTimeout(timer);
					ask.signal.removeEventListener("abort", aborted);
					ask.hurry?.removeEventListener("abort", hurried);
				};
				const leave = (why: unknown) => {
					const at = waiting.indexOf(one);
					if (at >= 0) waiting.splice(at, 1);
					settled();
					reject(why);
				};
				const aborted = () => leave(ask.signal.reason);
				const one: Waiting = {
					ahead: ask.ahead || ask.hurry?.aborted === true,
					go() {
						settled();
						resolve(given());
					},
				};
				const hurried = () => {
					const at = waiting.indexOf(one);
					if (at < 0 || one.ahead) return;
					waiting.splice(at, 1);
					one.ahead = true;
					queue(one);
				};
				queue(one);
				ask.signal.addEventListener("abort", aborted, { once: true });
				if (!one.ahead)
					ask.hurry?.addEventListener("abort", hurried, { once: true });
				if (ask.by !== Number.POSITIVE_INFINITY)
					timer = setTimeout(
						() => leave(ask.late()),
						Math.max(0, ask.by - Date.now()),
					);
			});
		},
	};
}
