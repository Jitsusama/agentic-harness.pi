/** What the meter is reporting. */
export interface Spend {
	/** What this process has spent, main loop and fan-out together. */
	readonly session: number;
	/** What the day has cost, this process included. */
	readonly day: number;
}

/** Sigma, marking a cumulative tally rather than a live reading. */
const TOTAL = "\u03a3";

/** Above this, cents are noise and the width is better spent elsewhere. */
const CENTS_BELOW = 100;

function money(value: number): string {
	return value >= CENTS_BELOW
		? `$${Math.round(value)}`
		: `$${value.toFixed(2)}`;
}

/**
 * Render the one cost figure the status line carries.
 *
 * Returns null when there is nothing to say. A status line is scarce and
 * a segment reading zero earns none of it.
 *
 * The session figure keeps cents because it is watched while it moves.
 * The day figure is context rather than a reading, so it is rounded: the
 * three characters are worth more to the segments that degrade after it.
 */
export function formatCostMeter(spend: Spend): string | null {
	const session = spend.session > 0 ? `${TOTAL}${money(spend.session)}` : null;
	// Printing the same number twice is worse than printing it once, which
	// is what the first session of a day would otherwise do.
	const dayIsMore = spend.day > spend.session;
	const day = spend.day > 0 && dayIsMore ? `d$${Math.round(spend.day)}` : null;
	const parts = [session, day].filter((part): part is string => part !== null);
	return parts.length > 0 ? parts.join(" ") : null;
}
