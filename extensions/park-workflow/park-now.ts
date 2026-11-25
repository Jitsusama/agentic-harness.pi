/**
 * Answering the person's Park from outside the window, as the park
 * watch does: a check says whether it would park, a park parks, and
 * either is answered whatever it meets, since an ask left unanswered
 * reads as one with nothing here to wake it.
 */

import type { ParkNowAsk } from "../../lib/internal/session/park.ts";

/**
 * Answers `ask` from `check`, which parks nothing, or `park`, each
 * saying why not where it doesn't. One that throws is answered as a
 * park that failed part-way, which may already have said it parked.
 */
export function answerParkNow(
	ask: ParkNowAsk,
	check: () => string | undefined,
	park: () => string | undefined,
): void {
	try {
		if (ask.check === true) {
			const why = check();
			if (why === undefined) ask.ready = true;
			else ask.why = why;
			return;
		}
		const why = park();
		if (why === undefined) ask.parked = true;
		else ask.why = why;
	} catch (error) {
		const said = error instanceof Error ? error.message : String(error);
		ask.why = `its park failed part-way, so it may read as parked until it is restarted: ${said || "with no reason given"}`;
	}
}
