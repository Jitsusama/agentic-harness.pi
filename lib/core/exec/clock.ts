/**
 * A command's clock, which stands still while the command says it waits
 * its turn.
 *
 * A clock that ends a command which will never finish should not end one
 * that is only queued. A push to World waits at the push gate's hook,
 * for as long as half an hour, while another push runs, and a clock
 * counting that wait stopped queued pushes before their turn came. So a
 * command that names a turn is read as it speaks: from the line saying
 * it waits until one saying its turn came, the run's clock stands still
 * and a wait's own clock runs instead, so a wait that never ends is
 * still ended.
 */

/** How a command says it waits its turn, and how long one wait may last. */
export interface Turn {
	/** What it says on stderr when a wait starts. */
	waits: string;
	/** What it says when the wait ends: any one of these. */
	goes: readonly string[];
	/** The longest one wait may hold the run's clock still. */
	longestMs: number;
}

/** What the clock was told: what the command said since, and the end. */
export interface Clock {
	/** Read what the command has said on stderr so far, all of it. */
	heard(stderr: string): void;
	/** Stop every timer, the command having ended. */
	stop(): void;
}

/**
 * A clock of `timeoutMs` that calls `timedOut` with why once it runs out,
 * standing still through each wait `turn` names.
 */
export function startClock(
	timeoutMs: number,
	turn: Turn | undefined,
	timedOut: (why: string) => void,
	command: string,
): Clock {
	let left = timeoutMs;
	let since = Date.now();
	let timer: NodeJS.Timeout | undefined;
	let waiting = false;
	// How far into stderr has been read for a mark, so each mark is
	// found once, including one split across two chunks.
	let read = 0;

	const run = (): void => {
		since = Date.now();
		timer = setTimeout(
			() => timedOut(`${command} timed out after ${timeoutMs} ms`),
			left,
		);
	};
	const hold = (longestMs: number): void => {
		clearTimeout(timer);
		left = Math.max(0, left - (Date.now() - since));
		timer = setTimeout(
			() => timedOut(`${command} waited its turn for over ${longestMs} ms`),
			longestMs,
		);
	};

	run();
	return {
		heard(stderr) {
			if (turn === undefined) return;
			for (;;) {
				const marks = waiting ? turn.goes : [turn.waits];
				const found = firstOf(stderr, marks, read);
				if (found === undefined) {
					const longest = Math.max(...marks.map((mark) => mark.length));
					read = Math.max(read, stderr.length - longest + 1);
					return;
				}
				read = found;
				clearTimeout(timer);
				waiting = !waiting;
				if (waiting) hold(turn.longestMs);
				else run();
			}
		},
		stop() {
			clearTimeout(timer);
		},
	};
}

/** Where the first of `marks` found in `text` from `from` ends. */
function firstOf(
	text: string,
	marks: readonly string[],
	from: number,
): number | undefined {
	let end: number | undefined;
	let start = Number.POSITIVE_INFINITY;
	for (const mark of marks) {
		const at = text.indexOf(mark, from);
		if (at !== -1 && at < start) {
			start = at;
			end = at + mark.length;
		}
	}
	return end;
}
