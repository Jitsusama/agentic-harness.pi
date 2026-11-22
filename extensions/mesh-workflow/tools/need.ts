/**
 * mesh_send's `need`: the word in `to` that asks for whichever live cell
 * works on what a message is about, found by the node's hubs and ties
 * (lib/mesh/need-route.ts), in place of asking an orchestrator to know.
 *
 * Only the cell found is written to, and as asked: a question to it is a
 * question to that one peer, and an fyi stays an fyi, so a need gives no
 * cell on its way a turn. A need nothing within reach works on is not
 * sent at all, and never to a leader instead: it is kept as lost, so the
 * measure counts it, and the sender is told to name the peers it is for.
 *
 * A need finds who works on something and grants nothing, since a cell
 * is found by what it says it works on, its title, repository and
 * declared subjects: a yes, a ruling or a grant
 * still comes only from the owner named by address, and each answer
 * says so.
 */

import { needNamed } from "../../../lib/mesh/group.ts";
import {
	type NeedRecord,
	needId,
	saidDigest,
	wordsOf,
} from "../../../lib/mesh/need-route.ts";
import { stoppedBy } from "../../../lib/mesh/stop.ts";
import { type Answer, answer, type Local, peers } from "./local.ts";
import type { SendDetails, SendParams } from "./send.ts";

/** What every need's answer says, since a fit is no owner. */
export const NEED_GRANTS_NOTHING =
	"A need finds who works on something; a yes, ruling or grant still comes only from the owner you name by address.";

/** What `to` says once a need in it is read, or why it may not be sent. */
export type NeedRead =
	| { readonly to: string; readonly note?: string }
	| { readonly refused: Answer };

/**
 * `to` with the word `need` read as the address of the live cell that
 * works on what the message is about: its `about`, or else its text.
 * `to` as written when it names no need.
 */
export async function needRead(
	at: Local,
	params: SendParams,
	now: number = Date.now(),
): Promise<NeedRead> {
	const named = needNamed(params.to ?? "");
	if (!named.asked) return { to: params.to ?? "" };
	const refused = (why: string): NeedRead => ({
		refused: answer(`Not sent: ${why}`, { sent: false } satisfies SendDetails),
	});
	const fromText = params.about === undefined;
	const words = wordsOf(params.about ?? params.text);
	const [asker, ...selves] = at.peer.addresses;
	if (words.length === 0) {
		return refused(
			"a need goes to whichever cell works on what it is about, and nothing in it says what that is. Say it in about, in a few words of the work.",
		);
	}
	if (asker === undefined || !at.need) {
		return refused(
			"this peer has no address to ask a need from yet. Name the peers it is for by address.",
		);
	}
	const standing = await peers(at);
	// A peer that stopped this one is not written to, so it can't take
	// a need from it either; it is there, so it is live and may be found
	// through, since the need goes to its fit alone, and it is never said
	// to have ended, only to have stopped this peer when the need is lost.
	const stopped = new Set(
		stoppedBy(at.peer, standing.present).flatMap(
			({ stopper }) => stopper.addresses,
		),
	);
	const live = new Set(standing.present.flatMap((one) => one.addresses));
	const found = await at.need(
		{
			need: needId(asker, now),
			asker,
			words,
			at: now,
			said: saidDigest(params.text),
			fromText,
			selves,
		},
		(address) => live.has(address),
		(address) => stopped.has(address),
	);
	if (found === undefined) {
		return refused(
			"no node answered to say which cell works on it, and a need goes to no orchestrator in its place. Name the peers it is for by address.",
		);
	}
	const about = found.words.join(" ");
	if (found.words.length === 0) {
		return refused(
			fromText
				? "no word of its text is one any cell works on, so it is counted as lost, never sent to an orchestrator. Say what it is about in about, or name the peers it is for by address."
				: "no word of its about is one any cell works on, so it is counted as lost, never sent to an orchestrator. Say it in other words of the work, or name the peers it is for by address.",
		);
	}
	const ended = endedText(found);
	if (found.fit === null) {
		// A peer that stopped this one refuses a send, so it isn't offered.
		const instead =
			(found.stopped ?? []).length > 0
				? "Name another peer it is for by address."
				: "Name the peers it is for by address.";
		return refused(
			`no live cell within three ties that hears this peer works on ${about}.${ended}${stoppedText(found)} It is counted as lost, never sent to an orchestrator. ${instead}`,
		);
	}
	if (found.fit === asker) {
		return refused(
			`this peer works on all of ${about} itself, so there is no other cell to ask. Name the peers it is for by address if it is for someone else.`,
		);
	}
	return {
		to: [found.fit, named.to].filter((one) => one !== "").join(", "),
		note: `The need, about ${about}, went to ${found.fit}, which works on it; it was found along ${found.path.join(", then ")}.${ended} ${NEED_GRANTS_NOTHING}`,
	};
}

/** Who works on a lost need but stopped this peer, as a sentence, or nothing. */
function stoppedText(found: NeedRecord): string {
	const stopped = found.stopped ?? [];
	if (stopped.length === 0) return "";
	const one = stopped.length === 1;
	return ` ${stopped.join(", ")} ${one ? "works" : "work"} on it but stopped this peer, so ${one ? "it doesn't" : "they don't"} hear it.`;
}

/** Who was passed over for having ended, as a sentence, or nothing. */
function endedText(found: NeedRecord): string {
	const ended = found.ended ?? [];
	if (ended.length === 0) return "";
	return ` ${ended.join(", ")} ${ended.length === 1 ? "works" : "work"} on it but ${ended.length === 1 ? "has" : "have"} ended, so ${ended.length === 1 ? "it was" : "they were"} passed over.`;
}
