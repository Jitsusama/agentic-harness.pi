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
 * still ended. The wait's clock counts every wait together, so a command
 * saying it waits over and over still ends.
 *
 * Both clocks read `performance.now()`, which a change to the wall
 * clock doesn't move.
 */

import { performance } from "node:perf_hooks";

/** How a command says it waits its turn, and how long it may wait. */
export interface Turn {
	/** What it says on stderr when a wait starts. */
	waits: string;
	/** What it says when the wait ends: any one of these. */
	goes: readonly string[];
	/** The longest its waits, all together, may hold the run's clock. */
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
 * standing still through each wait `turn` names. A turn with an empty
 * mark is no turn, since an empty mark is found everywhere.
 */
export function startClock(
	timeoutMs: number,
	given: Turn | undefined,
	timedOut: (why: string) => void,
	command: string,
): Clock {
	const turn = heardAs(given);
	let left = timeoutMs;
	let waitLeft = turn?.longestMs ?? 0;
	let since = performance.now();
	let timer: NodeJS.Timeout | undefined;
	let waiting = false;
	// How far into stderr has been read for a mark, so each mark is
	// found once, including one split across two chunks.
	let read = 0;

	// Each clock keeps what it has left when the other takes over.
	const spent = (): number => {
		const now = performance.now();
		const took = now - since;
		since = now;
		return took;
	};
	const runFor = (): NodeJS.Timeout =>
		setTimeout(
			() => timedOut(`${command} timed out after ${timeoutMs} ms`),
			left,
		);
	const run = (): void => {
		waitLeft = Math.max(0, waitLeft - spent());
		timer = runFor();
	};
	const hold = (longestMs: number): void => {
		left = Math.max(0, left - spent());
		timer = setTimeout(
			() => timedOut(`${command} waited its turn for over ${longestMs} ms`),
			waitLeft,
		);
	};

	timer = runFor();
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

/** The turn as read: without its empty marks, and none with no mark left. */
function heardAs(turn: Turn | undefined): Turn | undefined {
	if (turn === undefined || turn.waits === "") return undefined;
	const goes = turn.goes.filter((mark) => mark !== "");
	return goes.length === 0 ? undefined : { ...turn, goes };
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
