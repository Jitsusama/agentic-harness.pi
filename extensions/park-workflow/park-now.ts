/**
 * Answering the person's Park from outside the window, as the park
 * watch does: a check says whether it would park, a park parks, and
 * either is answered whatever it meets, since an ask left unanswered
 * reads as one with nothing here to wake it.
 */

import { messageOf } from "../../lib/internal/carry/message.ts";
import type { ParkNowAsk } from "../../lib/internal/session/park.ts";
import { ParkLeftHalfDone } from "./undo.ts";

/**
 * Answers `ask` from `check`, which parks nothing, or `park`, each
 * saying why not where it doesn't. One that throws is answered as a
 * park that failed, its watch having taken back what it said, or, where
 * it couldn't, as one that failed part-way and may still read as parked.
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
		ask.why =
			error instanceof ParkLeftHalfDone
				? leftOf(error)
				: `its park failed: ${messageOf(error)}`;
	}
}

/**
 * What a take-back that couldn't put everything back says: that it may
 * read as parked only where a part it left does, then each part, those
 * that read awake last.
 */
function leftOf(error: ParkLeftHalfDone): string {
	const parts = [...error.left, ...error.awake];
	const failed = error.readsParked
		? "its park failed part-way, so it may read as parked until it is restarted"
		: "its park failed";
	const said = `${failed}: ${error.message}`;
	return parts.length === 0 ? said : `${said}. And ${parts.join(", and ")}`;
}
