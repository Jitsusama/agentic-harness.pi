/**
 * Waiting for a page to stop changing, so a read that follows
 * describes where the page ended up rather than where it was.
 *
 * The DOM and the network each miss a case the other catches,
 * so both have to hold at once, and since satisfying one can
 * disturb the other they are rechecked together until they
 * agree or the budget runs out.
 */

import type { NetworkRequest } from "../telemetry/index.js";
import {
	inFlight,
	SETTLE_BUDGET_MS,
	SETTLE_QUIET_MS,
	type Settled,
	settleSource,
} from "../wait/index.js";
import type { SessionWires } from "./wires.js";

/**
 * Whether the settle probe came back with what it promised.
 *
 * Page-side results arrive as unknown, and a navigation landing
 * mid-evaluate resolves with nothing at all, so this is narrowed
 * rather than asserted.
 */
function isSettled(value: unknown): value is Settled {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<Settled>;
	return (
		typeof candidate.quiet === "boolean" &&
		typeof candidate.waitedMs === "number" &&
		typeof candidate.mutations === "number"
	);
}

/** The wait between a change and an honest reading of it. */
export class PageSettler {
	/** What the last settle saw, so a reader can qualify its answer. */
	private last: Settled | undefined;

	constructor(
		private readonly wires: SessionWires,
		/** The request log, for what may yet rewrite the page. */
		private readonly requests: () => readonly NetworkRequest[],
	) {}

	/** What the last settle saw, for a reader that wants to say so. */
	get lastSeen(): Settled | undefined {
		return this.last;
	}

	/**
	 * Wait for the page to stop changing.
	 *
	 * Returns what it found instead of throwing on a page that never
	 * settles: something that animates or polls for ever is still
	 * worth reading, as long as the answer does not pretend it was
	 * final.
	 *
	 * The budget is a parameter rather than only a constant because
	 * what it has to exceed is the quiet interval, and both stretch
	 * on a machine under load. A caller that needs "this page is
	 * quiet" to be answered reliably has to be able to say how long
	 * it is willing to wait for that, rather than inheriting a number
	 * chosen for an interactive read. Two browser tests asserting
	 * exactly that property failed intermittently for want of this.
	 */
	async settle(budgetMs: number = SETTLE_BUDGET_MS): Promise<Settled> {
		const started = Date.now();
		let mutations = 0;
		let quiet = false;
		// The DOM and the network each miss a case the other catches.
		//
		// A client-side navigation waiting on a fetch touches nothing
		// for as long as the request takes, so the DOM goes quiet and
		// the page then changes completely a moment later: pressing
		// Enter on a search box answered with the pre-search page for
		// exactly this reason. Meanwhile Chrome's network idle fires
		// before an app that already has its data has rendered any of
		// it.
		//
		// So both have to hold at once, and since satisfying one can
		// disturb the other, they are rechecked together until they
		// agree or the budget runs out.
		while (Date.now() - started < budgetMs) {
			const left = budgetMs - (Date.now() - started);
			const outcome = await this.wires
				.page()
				.evaluate(settleSource(SETTLE_QUIET_MS, left))
				.catch(() => undefined);
			if (isSettled(outcome)) {
				mutations += outcome.mutations;
				quiet = outcome.quiet;
			} else {
				// A navigation landed mid-evaluate, which is itself the
				// change we are waiting out. Go round again.
				quiet = false;
			}
			if (!quiet) continue;
			if (inFlight(this.requests()).length === 0) break;
			// Something is outstanding that may yet rewrite the page.
			quiet = false;
		}
		this.last = {
			quiet,
			waitedMs: Date.now() - started,
			mutations,
		};
		return this.last;
	}
}
