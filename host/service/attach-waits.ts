/**
 * What the journal says of a window's attach that waits: when it has
 * waited past a bound and on what, each step after that holds it past
 * the bound again, and how it ended, answered or refused. An attach
 * answered at once says nothing.
 */

/**
 * How long a window's attach may wait for its answer, or go undrawn
 * after it, before the journal says so. Six windows attached during a
 * host's start on 18 November sat blank for 2 h 20 min, and nothing
 * kept could say which wait never settled.
 */
export const ATTACH_SLOW_MS = 5_000;

const MS_PER_SECOND = 1_000;

/** Seconds since `began`, to a tenth, as the journal says a wait. */
export function secondsSince(began: number): string {
	return ((Date.now() - began) / MS_PER_SECOND).toFixed(1);
}

/** The steps of one attach as they begin, and its end. */
export interface AttachWaits {
	/** Begins the step named `waiting`, ending the one before. */
	next(waiting: string): void;
	/**
	 * Ends the attach, saying how if it was slow: answered, or refused
	 * with `refusal`'s reason.
	 */
	done(refusal?: unknown): void;
}

/**
 * The waits of `who`'s attach, journaled through `say`. The whole attach
 * passing `slowMs` says the step it is on, however many quicker steps
 * came before; after that, each step that itself passes `slowMs` says so
 * again, and one that gives way at once says nothing.
 */
export function attachWaits(
	who: string,
	say: ((line: string) => void) | undefined,
	slowMs: number = ATTACH_SLOW_MS,
): AttachWaits {
	const began = Date.now();
	let slow = false;
	let waitingOn = "";
	let timer: NodeJS.Timeout | undefined;
	const arm = () => {
		clearTimeout(timer);
		timer = setTimeout(() => {
			slow = true;
			say?.(
				`${who}: a window's attach has waited ${secondsSince(began)} s, now on ${waitingOn}`,
			);
		}, slowMs);
		// A host stopping never waits on a window's journal line.
		timer.unref();
	};
	return {
		next(waiting) {
			waitingOn = waiting;
			if (timer === undefined || slow) arm();
		},
		done(refusal) {
			clearTimeout(timer);
			if (!slow) return;
			if (refusal === undefined)
				say?.(
					`${who}: a window's attach was answered after ${secondsSince(began)} s`,
				);
			else
				say?.(
					`${who}: a window's attach was refused after ${secondsSince(began)} s: ${reasonOf(refusal)}`,
				);
		},
	};
}

// A refusal's reason on one line, as the journal keeps one line a wait.
function reasonOf(refusal: unknown): string {
	const text = refusal instanceof Error ? refusal.message : String(refusal);
	return text.replace(/\s+/g, " ").trim();
}
