/**
 * Turns for the runs a restart cut off, so a host coming back carries a
 * few on at once rather than every one.
 *
 * A host resumes its conversations one at a time, but each resumed
 * conversation's run then went at once: with fifteen held after a
 * restart, every cut-off run asked its model and ran its tools together
 * (WCJQSG, 15 November). A run now waits for a turn before durable carries
 * it on, and keeps it until its first answer after the restart ends, or
 * RESUMED_TURN_MS at most, so the start's burst is spread over minutes
 * while no long run holds back the ones behind it, nor the words sent to
 * them. A start holds every turn until its last conversation has resumed,
 * so the order is the whole start's rather than whichever resumed first:
 * a run begun by words Joel typed goes first, since he is waiting on its
 * answer, then the rest in the order they asked, which is the order the
 * host held them in. Outside a start the turns are open, so a wake or an
 * open waits on nothing but the cap.
 */
import { isPersonWords } from "../../lib/internal/session/driven.ts";
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

/** Give back a turn; giving it back again does nothing. */
export type GiveBack = () => void;

/**
 * Wait for a turn to carry a cut-off run on, `first` for one Joel's words
 * began. An abort ends the wait at once with a turn that counts for
 * nothing, since an aborted run ends without going on.
 */
export type TakeTurn = (
	first: boolean,
	signal?: AbortSignal,
) => Promise<GiveBack>;

/** The turns one host gives its cut-off runs. */
export interface ResumeTurns {
	readonly take: TakeTurn;
	/** Hold every turn as a start begins resuming what it holds. */
	hold(): void;
	/** Let the turns go once the start has resumed everything it holds. */
	open(): void;
	/** How many runs hold a turn now. */
	going(): number;
}

interface Waiting {
	readonly first: boolean;
	readonly grant: () => void;
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
		while (!held && going < atOnce && waiting.length > 0) {
			const firstAt = waiting.findIndex((each) => each.first);
			const [chosen] = waiting.splice(Math.max(firstAt, 0), 1);
			going++;
			chosen?.grant();
		}
	};
	return {
		take(first, signal) {
			if (signal?.aborted) return Promise.resolve(() => {});
			return new Promise<GiveBack>((resolve) => {
				const each: Waiting = {
					first,
					grant: () => {
						signal?.removeEventListener("abort", aborted);
						resolve(giveBack());
					},
				};
				const aborted = () => {
					const at = waiting.indexOf(each);
					if (at < 0) return;
					waiting.splice(at, 1);
					resolve(() => {});
				};
				signal?.addEventListener("abort", aborted, { once: true });
				waiting.push(each);
				next();
			});
		},
		hold() {
			held = true;
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
		if (message?.role === "user")
			return isPersonWords({ type: "message", message });
	}
	return false;
}
