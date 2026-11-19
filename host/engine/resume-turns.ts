/**
 * Turns for the runs a restart cut off, so a host coming back carries a
 * few on at once rather than every one.
 *
 * A host resumes its conversations a few at a time, and each resumed
 * conversation's run used to go at once: with fifteen held after a
 * restart, every cut-off run asked its model and ran its tools together
 * (WCJQSG, 15 November). A run now waits for a turn before durable carries
 * it on, and keeps it until its first answer after the restart ends, or
 * RESUMED_TURN_MS at most, so the start's burst is spread over minutes
 * while no long run holds back the ones behind it, nor the words sent to
 * them. A start holds back every run Joel doesn't wait on until its last
 * conversation has resumed, so the order is the whole start's rather than
 * whichever resumed first. A run he types into while it waits goes first,
 * since he is at its window now; then one begun by words he typed before
 * the restart, since he waits on its answer; then the rest in the order
 * they asked, which is roughly the order the host held them in, since a
 * few resume at once. The runs Joel waits on go even while the start
 * still holds the rest, up to the cap: on 19 November his words into a
 * carried turn waited seven minutes behind a start resuming 84
 * conversations. Outside a start the turns are open, so a wake or an open
 * waits on nothing but the cap.
 */
import {
	isPersonWords,
	userTextOf,
} from "../../lib/internal/session/driven.ts";
import { isOthersSteerText } from "../../lib/mesh/steer.ts";
import type { AgentMessage } from "./pi-types.ts";

/** How many cut-off runs a host carries on at once as it comes back. */
export const RESUMED_RUNS_AT_ONCE = 4;

/**
 * How long a carried run keeps its turn at most. A builder's run can go
 * on for an hour of rounds and tools, and runs waiting behind it hold
 * back any words sent to them, Joel's among them; the aim is to spread
 * the burst of a start, so the last runs go minutes later, not hours.
 */
export const RESUMED_TURN_MS = 60_000;

/**
 * How often a start that holds the turns looks again at the runs
 * waiting, since whether Joel waits on one is a question asked of it,
 * not something it says: words he types move it up within a second.
 */
export const LOOK_AGAIN_MS = 1_000;

/** Give back a turn; giving it back again does nothing. */
export type GiveBack = () => void;

/**
 * How Joel waits on a cut-off run: typing into it since the restart,
 * waiting on the answer to words he typed before it, or not at all.
 */
export type JoelWaits = "typing" | "began" | "not";

/** Joel's ways of waiting, the one that goes first first. */
const WAITS_FIRST: readonly JoelWaits[] = ["typing", "began"];

/**
 * Wait for a turn to carry a cut-off run on, `waits` saying how Joel
 * waits on it: asked again at each look and each turn that comes free
 * rather than once as the run asks, so a run he types into while it waits
 * moves up. An abort ends the wait at once with a turn that counts for
 * nothing, since an aborted run ends without going on.
 */
export type TakeTurn = (
	waits: () => JoelWaits,
	signal?: AbortSignal,
) => Promise<GiveBack>;

/** The turns one host gives its cut-off runs. */
export interface ResumeTurns {
	readonly take: TakeTurn;
	/**
	 * Hold back every run Joel doesn't wait on as a start begins resuming
	 * what it holds; the ones he waits on still go, up to the cap.
	 */
	hold(): void;
	/** Let every run go once the start has resumed everything it holds. */
	open(): void;
	/** How many runs hold a turn now. */
	going(): number;
}

interface Waiting {
	readonly waits: () => JoelWaits;
	readonly grant: () => void;
}

/** Where in `waiting` the run to go next is, or -1 while `held` keeps every one back. */
function nextAt(waiting: readonly Waiting[], held: boolean): number {
	const ways = waiting.map((each) => each.waits());
	for (const way of WAITS_FIRST) {
		const at = ways.indexOf(way);
		if (at >= 0) return at;
	}
	return held ? -1 : 0;
}

/**
 * Turns for at most `atOnce` cut-off runs at a time, each going back by
 * itself once it has been out for `lentMs`.
 */
export function resumeTurns(
	atOnce = RESUMED_RUNS_AT_ONCE,
	lentMs = RESUMED_TURN_MS,
): ResumeTurns {
	let held = false;
	let going = 0;
	const waiting: Waiting[] = [];
	let looking: ReturnType<typeof setInterval> | undefined;
	const giveBack = (): GiveBack => {
		let given = false;
		const back = () => {
			if (given) return;
			given = true;
			clearTimeout(lent);
			going--;
			next();
		};
		const lent = setTimeout(back, lentMs);
		// A lent turn keeps no host alive that has nothing else to do.
		lent.unref?.();
		return back;
	};
	const next = () => {
		while (going < atOnce && waiting.length > 0) {
			const at = nextAt(waiting, held);
			if (at < 0) break;
			const [chosen] = waiting.splice(at, 1);
			going++;
			chosen?.grant();
		}
		lookWhileHeld();
	};
	// Looks again only while a start holds the turns and a run waits on one.
	const lookWhileHeld = () => {
		const wanted = held && waiting.length > 0;
		if (wanted && looking === undefined) {
			// Paced at LOOK_AGAIN_MS, so Joel's words move a run up within a second.
			looking = setInterval(next, LOOK_AGAIN_MS);
			// A look keeps no host alive that has nothing else to do.
			looking.unref?.();
		} else if (!wanted && looking !== undefined) {
			clearInterval(looking);
			looking = undefined;
		}
	};
	return {
		take(waits, signal) {
			if (signal?.aborted) return Promise.resolve(() => {});
			return new Promise<GiveBack>((resolve) => {
				const each: Waiting = {
					waits,
					grant: () => {
						signal?.removeEventListener("abort", aborted);
						resolve(giveBack());
					},
				};
				const aborted = () => {
					const at = waiting.indexOf(each);
					if (at < 0) return;
					waiting.splice(at, 1);
					lookWhileHeld();
					resolve(() => {});
				};
				signal?.addEventListener("abort", aborted, { once: true });
				waiting.push(each);
				next();
			});
		},
		hold() {
			held = true;
			lookWhileHeld();
		},
		open() {
			held = false;
			next();
		},
		going: () => going,
	};
}

/**
 * Whether the turn a restart cut off began from words a person wrote: the
 * newest user message is the run's own input or a steer into it, and a
 * turn the harness started opens with its header, as a peer's or a job's
 * does. The message is read as its log line holds it, the way the cutover
 * tells a person's session from a builder's.
 */
export function beganWithPersonsWords(
	messages: readonly AgentMessage[],
): boolean {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role === "user") return isJoelsWords(message);
	}
	return false;
}

/**
 * Whether `message` is words Joel wrote: a person's, by having no
 * harness header, and no steer a peer agent or the machine wrote, which
 * reaches a session as a user's words without that header too.
 */
export function isJoelsWords(message: AgentMessage): boolean {
	const entry = { type: "message", message };
	if (!isPersonWords(entry)) return false;
	return !isOthersSteerText(userTextOf(entry) ?? "");
}
