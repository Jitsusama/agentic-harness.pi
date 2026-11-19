/**
 * What the journal says of a window's attach that waits: each step that
 * holds it past a bound, when it is answered after one did, and, once
 * answered, its first frame or that nothing was sent to draw. An attach
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
	/** Ends the attach, saying when it was answered if a step was slow. */
	done(): void;
}

/**
 * The waits of `who`'s attach, each journaled through `say` once it
 * passes `slowMs` itself, so a slow step that gives way to a fast one
 * says nothing more.
 */
export function attachWaits(
	who: string,
	say: ((line: string) => void) | undefined,
	slowMs: number = ATTACH_SLOW_MS,
): AttachWaits {
	const began = Date.now();
	let slow = false;
	let timer: NodeJS.Timeout | undefined;
	return {
		next(waiting) {
			clearTimeout(timer);
			timer = setTimeout(() => {
				slow = true;
				say?.(
					`${who}: a window's attach has waited ${secondsSince(began)} s on ${waiting}`,
				);
			}, slowMs);
			// A host stopping never waits on a window's journal line.
			timer.unref();
		},
		done() {
			clearTimeout(timer);
			if (slow)
				say?.(
					`${who}: a window's attach was answered after ${secondsSince(began)} s`,
				);
		},
	};
}
