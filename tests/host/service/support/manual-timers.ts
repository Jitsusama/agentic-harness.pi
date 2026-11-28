/** Timers a stale-child test fires by hand, each run once, in the order they were set. */

/** A timer set, waiting for the test to fire it. */
interface DueTimer {
	readonly ms: number;
	readonly run: () => void;
}

/** Timers the test fires by hand, each run once; `after` sets one and returns its cancel. */
export function manualTimers() {
	const due: DueTimer[] = [];
	return {
		due,
		after: (ms: number, run: () => void) => {
			const timer = { ms, run };
			due.push(timer);
			return () => {
				const at = due.indexOf(timer);
				if (at >= 0) due.splice(at, 1);
			};
		},
		async fire() {
			const timer = due.shift();
			timer?.run();
			// The look awaits what the install says before it decides.
			await new Promise((resolve) => setImmediate(resolve));
		},
	};
}
