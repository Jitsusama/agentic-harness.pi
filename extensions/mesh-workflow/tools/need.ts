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
 */

import { needNamed } from "../../../lib/mesh/group.ts";
import { type NeedRecord, wordsOf } from "../../../lib/mesh/need-route.ts";
import { type Answer, answer, type Local, peers } from "./local.ts";
import type { SendDetails, SendParams } from "./send.ts";

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
	const words = wordsOf(params.about ?? params.text);
	const asker = at.peer.addresses[0];
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
	const live = new Set(standing.present.flatMap((one) => one.addresses));
	const found = await at.need(
		{ need: `${asker}/${now.toString(36)}`, asker, words, at: now },
		(address) => live.has(address),
	);
	const about = words.join(" ");
	if (found === undefined) {
		return refused(
			`no node answered to say which cell works on ${about}, and a need goes to no orchestrator in its place. Name the peers it is for by address.`,
		);
	}
	const ended = endedText(found);
	if (found.fit === null) {
		return refused(
			`no live cell within three ties works on ${about}.${ended} It is counted as lost, never sent to an orchestrator. Name the peers it is for by address.`,
		);
	}
	if (found.fit === asker) {
		return refused(
			`this peer works on all of ${about} itself, so there is no other cell to ask. Name the peers it is for by address if it is for someone else.`,
		);
	}
	return {
		to: [found.fit, named.to].filter((one) => one !== "").join(", "),
		note: `The need, about ${about}, went to ${found.fit}, which works on it; it was found along ${found.path.join(", then ")}.${ended}`,
	};
}

/** Who was passed over for having ended, as a sentence, or nothing. */
function endedText(found: NeedRecord): string {
	const ended = found.ended ?? [];
	if (ended.length === 0) return "";
	return ` ${ended.join(", ")} ${ended.length === 1 ? "works" : "work"} on it but ${ended.length === 1 ? "has" : "have"} ended, so ${ended.length === 1 ? "it was" : "they were"} passed over.`;
}
