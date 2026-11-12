/**
 * The take-up of one session's move asked with /host
 * (extensions/mesh-workflow/host-command.ts): the cutover's adopt for
 * that session alone, run once its pi has written its note.
 *
 * A move asked from inside the window has no cutover running to adopt
 * its log, and the join the window passes to takes the move back after
 * its grace (host/service/join.ts) if nothing does. So /host starts this
 * first, and it waits: for the note, which the pi writes once nothing of
 * its own is out; or for the move to be called off, or the pi to go
 * without a note, either of which ends it with nothing done. Once the
 * note is there it is the cutover's carryOut, given only that note, so
 * another session's note, or one the cutover or a release should take,
 * is never touched here.
 */

import { carryOut, LOOK_EVERY_MS, type MoveFacts } from "./cutover.ts";

/** Where the moving session stands, as its presence says. */
export type Standing = "moving" | "off" | "gone";

/** The take-up's facts: the cutover's, and where the session stands. */
export interface TakeUpFacts extends MoveFacts {
	/** Still waiting to move, called off, or its pi gone. */
	standing(session: string): Promise<Standing>;
}

/** How a take-up ended. */
export type TakenUp =
	| "moved"
	| "called off"
	| "gone"
	| "taken back"
	| "refused"
	| "unfinished";

/** `facts` seeing only `session`'s note, and only a move into a host. */
function onlyOf(session: string, facts: TakeUpFacts): MoveFacts {
	return {
		...facts,
		notes: () =>
			facts.notes().filter((one) => one.session === session && one.to !== "pi"),
	};
}

/**
 * Take up `session`'s move: wait until its note is there, then have the
 * host it names adopt the log once its pi has gone, until `deadline`.
 */
export async function takeUp(
	session: string,
	facts: TakeUpFacts,
	deadline: number,
): Promise<TakenUp> {
	const only = onlyOf(session, facts);
	for (;;) {
		const standing = await facts.standing(session);
		if (only.notes().length > 0) break;
		if (standing === "off") {
			facts.say(`${session}'s move was called off; nothing to take up`);
			return "called off";
		}
		if (standing === "gone") {
			facts.say(`${session}'s pi went leaving no note; nothing to take up`);
			return "gone";
		}
		if (facts.now() >= deadline) {
			facts.say(`${session} left no note by the deadline`);
			return "unfinished";
		}
		await facts.pause(LOOK_EVERY_MS);
	}
	const report = await carryOut([], only, deadline);
	if (report.moved.length > 0) return "moved";
	if (report.takenBack.length > 0) return "taken back";
	if (report.refused.length > 0) return "refused";
	return "unfinished";
}
