/**
 * One space, everywhere in the meter: between a marker and its value,
 * and between one pair and the next. A single rule with no exceptions,
 * held in one place so the call sites cannot drift apart from each
 * other, which is exactly how the gauge once ended up spaced and its
 * two neighbours not.
 */
export const GAP = " ";

/** Theme colours the meter names, applied by whoever renders it. */
export type MeterToken = "dim" | "warning" | "error";

/** A context reading: how full, how it should look, what it says. */
export interface ContextGauge {
	readonly glyph: string;
	readonly token: MeterToken;
	readonly text: string;
}

/**
 * Quarter-filled circles, the same progression the quest status set
 * already uses. Filling is the vocabulary for "how far along".
 */
const FILL = ["\u25d4", "\u25d1", "\u25d5", "\u25cf"] as const;

/** Where the gauge stops being quiet, and where it starts being loud. */
const WARNING_AT = 0.5;
const ERROR_AT = 0.8;

/** Sigma marks a total; the partial marks a rate. Neither is decoration. */
const TOTAL = "\u03a3";
const RATE = "\u2202";

/** Above this a total's cents are noise and the width is worth more. */
const CENTS_BELOW = 100;

/** Tokens per thousand, for the short reading. */
const THOUSAND = 1000;

/**
 * Read the context window as a filled gauge.
 *
 * The denominator is dropped because it does not change within a
 * session, so printing it spends four characters saying nothing. The
 * glyph carries it instead.
 *
 * A window of zero reads as empty rather than full. Dividing by it
 * would otherwise paint a full gauge and tell the reader they are about
 * to be compacted when nothing of the sort is known.
 */
export function contextGauge(
	tokens: number,
	window: number,
	asPercent = false,
): ContextGauge {
	const fraction = window > 0 ? Math.min(tokens / window, 1) : 0;
	const step = Math.min(Math.floor(fraction * FILL.length), FILL.length - 1);
	const token: MeterToken =
		fraction >= ERROR_AT ? "error" : fraction >= WARNING_AT ? "warning" : "dim";
	const text =
		asPercent && window > 0
			? `${Math.round(fraction * 100)}%`
			: `${Math.round(tokens / THOUSAND)}k`;
	return { glyph: FILL[step], token, text };
}

/**
 * The middle value, or nothing when there is none.
 *
 * Median rather than mean on purpose: a turn taken after an idle gap
 * costs around fifteen times a warm one, and a mean lets a single such
 * turn repaint a reading that is supposed to describe the session.
 */
export function medianOf(values: readonly number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1
		? sorted[middle]
		: (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * What one more turn costs, marked as a rate.
 *
 * Cents are always kept. The whole point of the figure is watching it
 * move, and it moves in cents.
 */
export function marginalText(marginal: number | null): string | null {
	if (marginal === null) return null;
	return `${RATE}${GAP}$${marginal.toFixed(2)}`;
}

/** What the session has cost so far, marked as a total. */
export function sessionText(session: number): string | null {
	if (session <= 0) return null;
	const amount =
		session >= CENTS_BELOW ? `${Math.round(session)}` : session.toFixed(2);
	return `${TOTAL}${GAP}$${amount}`;
}
