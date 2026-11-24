/**
 * mesh_send's `need`: the word in `to` that asks for whichever live cell
 * works on what a message is about, found by the node's hubs and ties
 * (lib/mesh/need-route.ts), in place of asking an orchestrator to know.
 *
 * Only the cell found is written to, and as asked: a question to it is a
 * question to that one peer, and an fyi stays an fyi, so a need gives no
 * cell on its way a turn. A need nothing within reach works on is not
 * sent at all, and passed to nobody in its place: it is kept as lost, so
 * the measure counts it, and the sender is told to name the peers it is
 * for or, not knowing who, to ask whoever is above it who owns it, by a
 * question rather than by handing the need up. The refusal names that
 * cell only where one is above: `orchestrator` under a mark, the head
 * of its quest by address, or a hub from use by address, the one it
 * keeps while the node is quiet included; with nothing above, or none
 * found, mesh_groups, which names what each peer works on. It never
 * says the need went to no orchestrator, since asking who owns it is
 * still the next step.
 *
 * A need finds who works on something and grants nothing, since a cell
 * is found by what it says it works on, its title, repository and
 * declared subjects: a yes, a ruling or a grant still comes only from
 * the person or from the work's owner, the peer whose own quest holds
 * it, which mesh_groups names apart from groups it joined, and each
 * answer says so.
 */

import { needNamed } from "../../../lib/mesh/group.ts";
import {
	LONGEST_WORD,
	MOST_WORDS,
	type NeedRecord,
	needId,
	saysWord,
	wordsOf,
} from "../../../lib/mesh/need-route.ts";
import { stoppedBy } from "../../../lib/mesh/stop.ts";
import { findAbove, orKept } from "./above.ts";
import { type Answer, answer, type Local, peers } from "./local.ts";
import type { SendDetails, SendParams } from "./send.ts";

/** What every need's answer says, since a fit is no owner. */
export const NEED_GRANTS_NOTHING =
	"A need finds who works on something; a yes, ruling or grant still comes only from the person or from the work's owner: the peer whose own quest holds it (mesh_groups names each peer's own quest), named by address.";

/**
 * What a lost need's refusal says to do when the asker can't name who it
 * is for, which is why it asked a need, and a mark names its
 * orchestrator: the cell above it knows who owns what, and is asked by
 * a question, never handed the need.
 */
export const ASK_WHO_OWNS_IT =
	"Not knowing who, ask the cell above this peer who owns it: a question to orchestrator.";

/**
 * What a lost need's refusal says to do, not knowing who, when the find
 * settled that nothing is above the asker for `orchestrator` to reach.
 */
export const FIND_WHO_OWNS_IT =
	"Not knowing who, nothing above this peer can be asked, so find the owner in mesh_groups, which names what each peer works on and its own quest, and ask it by address.";

/**
 * What a lost need's refusal says to do, not knowing who, when no find
 * could settle whether anything is above the asker and it keeps no hub:
 * a quiet node says nothing of what is above, so the refusal says only
 * that none could be found.
 */
export const FIND_WHILE_QUIET =
	"Not knowing who, nothing above this peer could be found while the node is quiet, so find the owner in mesh_groups, which names what each peer works on and its own quest, and ask it by address.";

/**
 * Whom a lost need's refusal says to ask who owns it, by where this peer
 * sits, so it never points at a route known to reach nobody and never
 * says nothing is above while `orchestrator` would still reach a hub:
 * the mark's orchestrator, the head of its quest, a hub from use, or the
 * hub this peer keeps when the node can't say (`orKept`, as a send reads
 * it), and otherwise mesh_groups. A fresh hub is looked for only when
 * the node answered the need, since finding one asks the same node;
 * otherwise the kept hub alone is read, judged against `gone`, the
 * sessions the need's own census found no longer on the mesh.
 */
async function whomToAsk(
	at: Local,
	nodeAnswered: boolean,
	gone: readonly string[],
): Promise<string> {
	if (at.peer.orchestratedBy !== undefined) return ASK_WHO_OWNS_IT;
	const head = at.peer.questHeads;
	if (head !== undefined && at.peer.orchestrates === undefined) {
		return `Not knowing who, ask ${head}, the head of this peer's quest, who owns it: a question to ${head}.`;
	}
	if (at.peer.orchestrates !== undefined) return FIND_WHO_OWNS_IT;
	const hub = (address: string) =>
		`Not knowing who, ask ${address}, the cell above this peer, who owns it: a question to ${address}.`;
	if (!nodeAnswered) {
		const kept = at.keptHub?.(gone);
		return kept === undefined ? FIND_WHILE_QUIET : hub(kept);
	}
	try {
		const found = orKept(await findAbove(at), at.keptHub);
		if ("address" in found.above) return hub(found.above.address);
		return found.settled ? FIND_WHO_OWNS_IT : FIND_WHILE_QUIET;
	} catch {
		// No hub could be found, so nothing above can be named to ask; a
		// throw says nothing settled, so the refusal says none was found.
		return FIND_WHILE_QUIET;
	}
}

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
	const gone = standing.gone.map((one) => one.session);
	const found = await at.need(
		{ need: needId(asker, now), asker, words, at: now, fromText, selves },
		(address) => live.has(address),
		(address) => stopped.has(address),
	);
	if (found === undefined) {
		return refused(
			`no node answered to say which cell works on it, and a need is passed to nobody in its place. Name the peers it is for by address. ${await whomToAsk(at, false, gone)}`,
		);
	}
	const about = found.words.join(" ");
	if (found.words.length === 0) {
		const retry = fromText
			? "no word of its text is one any cell works on, so it is counted as lost and passed to nobody in its place. Say what it is about in about, or name the peers it is for by address."
			: "no word of its about is one any cell works on, so it is counted as lost and passed to nobody in its place. Say it in other words of the work, or name the peers it is for by address.";
		return refused(`${retry} ${await whomToAsk(at, true, gone)}`);
	}
	const ended = endedText(found);
	// On 24 November a need about "dates delivery" went by delivery alone,
	// the dates cell having left the node, and its asker heard nothing of
	// dates. Only when MOST_WORDS were kept may a word some cell holds
	// have been dropped, so then nothing is said of the rest; nor of a
	// text's words, which may hold a token, nor of a word past
	// LONGEST_WORD, which is a token, not a word of work. A joined id,
	// mesh-workflow or pi-host, is held by none whose title says mesh
	// workflow or pi host, yet its parts
	// routed it, so it goes unsaid when the words kept say it as routing
	// reads them: every part long and rare enough to be a word, and a
	// numbered id, leg-27, only whole. A word kept that only ended cells
	// work on, which routing says, is said whatever was dropped.
	const kept = new Set(found.words);
	const unasked = (went: Went) =>
		unaskedText(
			fromText || found.words.length >= MOST_WORDS
				? []
				: words.filter(
						(word) => word.length <= LONGEST_WORD && !saysWord(word, kept),
					),
			found.unheld ?? [],
			found.words,
			went,
		);
	if (found.fit === null && found.fellShort !== undefined) {
		return refused(
			`${ownerText(found, found.fellShort, about)}${unasked("owned")} It is counted as lost and passed to nobody in its place. Name ${found.fellShort} or another peer it is for by address if it will do. ${await whomToAsk(at, true, gone)}`,
		);
	}
	if (found.fit === null) {
		// A peer that stopped this one refuses a send, so it isn't offered.
		const instead =
			(found.stopped ?? []).length > 0
				? "Name another peer it is for by address."
				: "Name the peers it is for by address.";
		return refused(
			`no live cell within three ties that hears this peer works on ${about}.${unasked("lost")}${ended}${stoppedText(found)} It is counted as lost and passed to nobody in its place. ${instead} ${await whomToAsk(at, true, gone)}`,
		);
	}
	if (found.fit === asker) {
		return refused(
			`this peer works on all of ${about} itself, so there is no other cell to ask. Name the peers it is for by address if it is for someone else.`,
		);
	}
	return {
		to: [found.fit, named.to].filter((one) => one !== "").join(", "),
		note: `The need, about ${about}, went to ${found.fit}, which works on it; it was found along ${found.path.join(", then ")}.${unasked("sent")}${ended} ${NEED_GRANTS_NOTHING}`,
	};
}

/**
 * What became of a need, as its words' sentence tells it: sent to its
 * fit, refused for an owner that ended, or lost with nothing found.
 */
type Went = "sent" | "owned" | "lost";

/**
 * The words of an about no cell works on, and of those kept no live
 * cell does, as a sentence, or nothing. A need sent says the words it
 * was routed by and one refused for its owner those its fit was found
 * by, a word only ended cells work on left out of either; a lost one,
 * having gone nowhere, says neither.
 */
function unaskedText(
	noCell: readonly string[],
	noLive: readonly string[],
	kept: readonly string[],
	went: Went,
): string {
	const unheld = new Set(noLive);
	const routed = kept.filter((word) => !unheld.has(word));
	const count = noCell.length + noLive.length;
	if (count === 0 || (went !== "lost" && routed.length === 0)) return "";
	const cells = [
		...(noCell.length > 0 ? [`No cell works on ${noCell.join(", ")}`] : []),
		...(noLive.length > 0
			? [
					noCell.length > 0
						? `no live cell on ${noLive.join(", ")}`
						: `No live cell works on ${noLive.join(", ")}`,
				]
			: []),
	].join(", and ");
	if (went === "lost") return ` ${cells}.`;
	const one = count === 1;
	const by = routed.join(" ");
	const tail =
		went === "sent"
			? `it was routed by ${by} alone`
			: `the live cell was found by ${by} alone`;
	return ` ${cells}, so ${one ? "it" : "they"} found nobody and ${tail}.`;
}

/**
 * Why a need whose owner has ended is lost though a live cell was found:
 * routing would have sent it to the one cell named in `ended`, were it
 * alone there, and that cell worked on more of it than `fit`. Said as
 * not present, since the node lists it with no presence here: it
 * crashed, or its presence never reached this machine, as one whose
 * machine is only out of reach still counts as there. Once it is back a resend reaches
 * it, or a cell covering as much or more that it leads to; unless it
 * stopped this one, which is known only of a present cell.
 */
function ownerText(found: NeedRecord, fit: string, about: string): string {
	const owner = (found.ended ?? []).join(", ");
	return `${owner} worked on more of ${about} than ${fit}, the live cell found, but isn't present now, so it was not sent to a cell sharing less of it. Sending it again once ${owner} is present reaches ${owner} or a cell covering as much of it or more, unless ${owner} has stopped this one.`;
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
