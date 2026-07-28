/**
 * How much memory the page is holding on to.
 *
 * A leak is the one fault none of the other instruments here can
 * see. Nothing renders wrong, nothing is logged, no request
 * fails; the tab simply gets slower for an hour and then dies,
 * and by then whatever caused it is a long way back.
 *
 * The measurement is nearly worthless on its own. Uncollected
 * garbage is indistinguishable from a leak, so a heap that grew
 * is evidence of nothing unless a collection was forced first.
 * That is why a reading carries whether it was collected, and why
 * a comparison says outright when it cannot be trusted.
 */

/** One measurement of what the page is holding. */
export interface HeapReading {
	readonly usedBytes: number;
	readonly totalBytes: number;
	/** Whether a collection was forced before measuring. */
	readonly collected: boolean;
	readonly at: number;
}

/** Two readings, and what changed between them. */
export interface HeapComparison {
	readonly now: HeapReading;
	readonly before?: HeapReading;
	/** Bytes gained since the earlier reading; negative if lost. */
	readonly grewBy?: number;
	readonly direction: "grew" | "fell" | "steady" | "unknown";
	/**
	 * Whether the comparison means anything.
	 *
	 * False when either reading was taken without forcing a
	 * collection, because then growth is as likely to be garbage
	 * nobody has swept as memory nobody can free.
	 */
	readonly trustworthy: boolean;
}

/**
 * Growth smaller than this is the runtime breathing, not a leak.
 *
 * Even after a forced collection a page's heap moves by tens of
 * kilobytes between readings, and reporting that as growth would
 * make every measurement look like a leak.
 */
const NOISE = 256 * 1024;

/** Compare a reading against an earlier one. */
export function compareHeap(
	now: HeapReading,
	before?: HeapReading,
): HeapComparison {
	if (before === undefined) {
		// One reading is a number, not a trend. Calling a first
		// measurement steady would be inventing news.
		return { now, direction: "unknown", trustworthy: now.collected };
	}

	const grewBy = now.usedBytes - before.usedBytes;
	const direction =
		Math.abs(grewBy) < NOISE ? "steady" : grewBy > 0 ? "grew" : "fell";

	return {
		now,
		before,
		grewBy,
		direction,
		trustworthy: now.collected && before.collected,
	};
}

/** Bytes as a person reads them. */
function mb(bytes: number): string {
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** Say what the page is holding, and whether that is growing. */
export function renderHeap(comparison: HeapComparison): string {
	const { now, before, grewBy, direction } = comparison;
	const lines = [
		`Holding ${mb(now.usedBytes)} of ${mb(now.totalBytes)} allocated.`,
	];

	if (before !== undefined && grewBy !== undefined) {
		if (direction === "steady") {
			lines.push(
				`Steady since the last reading, within ${mb(NOISE)} either way.`,
			);
		} else {
			const verb = direction === "grew" ? "Grew" : "Fell";
			lines.push(`${verb} by ${mb(Math.abs(grewBy))} since the last reading.`);
		}
	}

	if (!comparison.trustworthy) {
		// The single most misleading thing this could do is let a
		// reader take uncollected garbage for a leak, so the caveat
		// is not optional and does not get abbreviated.
		lines.push(
			"Not evidence of a leak: a collection was not forced, so " +
				"garbage nobody has swept yet is counted the same as memory " +
				"nobody can free. Take both readings with a collection " +
				"before comparing them.",
		);
	} else if (before === undefined) {
		lines.push(
			"One reading is a number, not a trend. Do the thing you " +
				"suspect, read again, and compare.",
		);
	}

	return lines.join("\n");
}
