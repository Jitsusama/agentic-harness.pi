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
	/** Ends the attach answered, saying so if it was slow. */
	answered(): void;
	/** Ends the attach refused for `refusal`, saying so if it was slow. */
	refused(refusal: unknown): void;
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
	// Ends the attach, saying how it ended if it was slow.
	const end = (how: string, why = "") => {
		clearTimeout(timer);
		if (slow)
			say?.(
				`${who}: a window's attach was ${how} after ${secondsSince(began)} s${why}`,
			);
	};
	return {
		next(waiting) {
			waitingOn = waiting;
			if (timer === undefined || slow) arm();
		},
		answered() {
			end("answered");
		},
		refused(refusal) {
			end("refused", `: ${reasonOf(refusal)}`);
		},
	};
}

/** The first character past C0's controls, which move or colour a terminal. */
const FIRST_PRINTABLE = 0x20;
/** DEL and C1's controls, which a terminal may act on too. */
const DEL = 0x7f;
const LAST_C1 = 0x9f;

// Whether `character` would show as itself rather than act on a terminal.
function printable(character: string): boolean {
	const code = character.codePointAt(0) ?? 0;
	return code >= FIRST_PRINTABLE && (code < DEL || code > LAST_C1);
}

// A refusal's reason on one plain line, as the journal keeps one line a
// wait: its whitespace one space, its control characters dropped.
function reasonOf(refusal: unknown): string {
	const text =
		refusal instanceof Error
			? refusal.message
			: refusal === undefined || refusal === null
				? ""
				: String(refusal);
	const plain = [...text.replace(/\s+/g, " ")]
		.filter(printable)
		.join("")
		.trim();
	return plain === "" ? "no reason given" : plain;
}
