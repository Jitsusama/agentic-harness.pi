/**
 * mesh_send: where a message goes, what it may say, who hears it, and
 * what is refused, here or across into another realm.
 */

import { refusalUnder } from "../../../lib/guardian/apply.ts";
import { GUARDS } from "../../../lib/internal/guardian/guards.ts";
import { namedAtStart } from "../../../lib/mesh/address.ts";
import type { Crossed } from "../../../lib/mesh/flow.ts";
import {
	ALL,
	groupNamed,
	groupsNamed,
	hears,
	homeOf,
	MACHINE,
	machineTakes,
	namesOrchestrator,
	needNamed,
	orchestratorNamed,
	personLeftOut,
	personNamed,
} from "../../../lib/mesh/group.ts";
import { lists, onQuestAbove } from "../../../lib/mesh/hub-from-use.ts";
import { isCurrent } from "../../../lib/mesh/lease.ts";
import {
	heading,
	type Message,
	reaches,
	senderIdentity,
	shortId,
} from "../../../lib/mesh/message.ts";
import type { Peer } from "../../../lib/mesh/peer.ts";
import { pivotTargets } from "../../../lib/mesh/pivot.ts";
import type { Presence } from "../../../lib/mesh/presence.ts";
import { type Route, routeOf } from "../../../lib/mesh/routing.ts";
import { isAddress } from "../../../lib/mesh/steer-who.ts";
import { stoppedBy } from "../../../lib/mesh/stop.ts";
import { idNamed, type Self, sentBy } from "../../../lib/mesh/thread.ts";
import { doneAlreadyRefusal } from "../../../lib/orchestration/done-acts.ts";
import { limitsRefusal } from "../../../lib/orchestration/unasked-limits.ts";
import { untestedCauseReason } from "../../../lib/prose/claims.ts";
import { handsRefusal } from "../joels-hands.ts";
import { type Found, findAbove, orKept } from "./above.ts";
import { type Answer, answer, type Local, peers } from "./local.ts";
import { needRead } from "./need.ts";
import { reach, unheardOf } from "./reach.ts";
import { capitalized } from "./said.ts";
import { stopsText } from "./stop.ts";

/** What mesh_send hands back beside its words. */
export interface SendDetails {
	readonly sent: boolean;
	/** The homes it was not written to, of peers that stopped this one. */
	readonly refused?: readonly string[];
	/** Where the mesh sent it, and why, when the sender named no group. */
	readonly routed?: Route;
	readonly message?: Message;
	/** The peers it goes to, by the address each signs with. */
	readonly reached?: readonly string[];
	/** The peers it was addressed to whose sessions have ended. */
	readonly gone?: readonly string[];
	/** What crossed into another realm, as the node sent it. */
	readonly crossed?: Crossed;
	/** Why the node refused a crossing, as it said it. */
	readonly crossRefused?: { readonly code: string; readonly why: string };
}

/**
 * The hold a send ends on the person's word, or why it ends none: only
 * another peer's hold can be, since this peer ends its own itself.
 */
function endedOnWord(
	at: Local,
	asked: boolean | undefined,
	re: string | undefined,
): { hold?: Message; why?: string } {
	if (!asked) return {};
	const hold = re ? at.transport.read(re) : undefined;
	if (hold?.intent !== "hold") {
		return {
			why: `${re ? `[${re.slice(re.lastIndexOf("-") + 1)}]` : "what it answers"} is no other peer's hold, so endsHold was left out`,
		};
	}
	// This peer's own hold is its to end, with no word to confirm.
	if (sentBy(hold, { addresses: at.peer.addresses, ...senderIdentity() })) {
		return {};
	}
	return { hold };
}

/** Why a note on this peer's own hold went answering nothing. */
function keptSaid(kept: Message): string {
	const id = shortId(kept);
	return `[${id}] is this peer's own hold, and answering it ends it for every peer it parked, so re was left out and it still holds: to end it, answer it with endsHold true; to change what it holds, replace [${id}] with supersedes`;
}

/**
 * This peer's own hold that a send answers without saying it ends it.
 * Answering its own hold ends it for every peer it parked, so that is
 * done only when the send says so with endsHold: on 12 November a
 * holder's note that a small push was fine during its hold answered it
 * with re, and ended it in the middle of the person's calls.
 */
function ownHoldKept(
	at: Local,
	named: string | undefined,
	ends: boolean | undefined,
	self: Self,
): Message | undefined {
	if (ends || named === undefined) return undefined;
	const answered = at.transport.read(named);
	return answered?.intent === "hold" && sentBy(answered, self)
		? answered
		: undefined;
}

/**
 * The intent a send goes with, and why when it is not the one asked: a
 * hold that answers a hold goes as an fyi. Answering this peer's own
 * hold ends it, so sent as a hold the end would put everyone off again
 * for two hours; and an answer to another peer's hold is news for its
 * sender, where a hold would park everyone it reached. Twice on 7
 * November an end of 85PKB2's went as a hold, and sessions woken hours
 * later answered it as one to park on. A hold that replaces this peer's
 * own (supersedes) stays one, since that is how a hold changes its words.
 */
export function answeringIntent(
	asked: Message["intent"],
	answered: Message | undefined,
	self: { readonly addresses: readonly string[]; readonly pid: number },
	replacing: Message | undefined,
): { intent: Message["intent"]; why?: string } {
	if (asked !== "hold" || answered?.intent !== "hold" || replacing) {
		return { intent: asked };
	}
	const id = shortId(answered);
	return {
		intent: "fyi",
		why: sentBy(answered, self)
			? `it answers [${id}], this peer's own hold, so it went as an fyi rather than a new hold; to hold on in other words, replace [${id}] with supersedes`
			: `it answers [${id}], another peer's hold, so it went as an fyi: a hold would park everyone it reached; send a hold of this peer's own without re`,
	};
}

/**
 * Whether these groups reach the orchestrator above the sender's quest,
 * by any address its presence goes by, in any letters: a group named is
 * always upper case, and a presence may list its address otherwise. A
 * presence lists what addresses it likes, so every one that lists the
 * orchestrator's counts, not the first: a check that fails closed counts
 * a question to an impostor's other address too, where taking the first
 * would let an impostor that sorts early hide the real one's.
 */
function toOrchestrator(
	named: readonly string[],
	orchestratedBy: string | undefined,
	present: readonly Presence[],
): boolean {
	if (orchestratedBy === undefined) return false;
	const addresses = [
		orchestratedBy,
		...present
			.filter((one) => lists(one, orchestratedBy))
			.flatMap((one) => one.addresses),
	];
	return addresses.some((address) =>
		named.includes(homeOf(address.toUpperCase())),
	);
}

/**
 * Whether these groups reach this peer's hub from use by an address:
 * found afresh when the send named no `orchestrator` to find it by, so
 * a question for the person's hands is counted the same way whichever
 * it was sent by, kept hub or none. A find that can't be finished, with
 * no answer from the node, can't say the address isn't the hub's, so it
 * counts as reaching it and the check is made rather than skipped,
 * whether the send's own `orchestrator` asked for it or this did. A
 * send naming no address that a live cell on a quest above this peer's
 * holds can't reach its hub, which is only ever found there, so it
 * waits on no find: a question to a peer's owner by address, the
 * common case, then costs no second census and no wait on the node.
 */
async function toHubByAddress(
	at: Local,
	asked: Found | undefined,
	named: readonly string[],
	present: readonly Presence[],
): Promise<boolean> {
	const byAddress = named.some((group) => group.startsWith(homeOf("")));
	if (!byAddress || at.peer.orchestratedBy !== undefined) return false;
	if (asked !== undefined) return !asked.settled;
	const self = present.find((one) => one.session === at.peer.session);
	if (
		self !== undefined &&
		!present.some(
			(one) =>
				onQuestAbove(self, one) &&
				one.addresses.some((address) =>
					named.includes(homeOf(address.toUpperCase())),
				),
		)
	) {
		return false;
	}
	const found = await findAbove(at);
	if (!found.settled) return true;
	return (
		"address" in found.above &&
		toOrchestrator(named, found.above.address, present)
	);
}

/** Whether the mesh's own routing, not the sender, picked the groups. */
function routedWide(
	routed: Route | undefined,
	aimed: readonly string[] | undefined,
	chosen: readonly string[],
): boolean {
	return routed !== undefined && aimed === undefined && chosen.length === 0;
}

/** What mesh_send is asked. */
export interface SendParams {
	readonly to?: string;
	readonly intent: Message["intent"];
	readonly text: string;
	readonly re?: string;
	readonly supersedes?: string;
	readonly endsHold?: boolean;
	readonly realm?: string;
	/** What a need named in `to` is about; its text, when left out. */
	readonly about?: string;
}

/**
 * Why a send may not answer `re`, when it names a message that crossed
 * from another realm: nothing said here reaches back there, so an answer
 * would be written where nobody who asked could read it.
 */
function crossedAnswerRefused(
	at: Local,
	re: string | undefined,
): Answer | undefined {
	const asked = re ? at.transport.read(re) : undefined;
	if (!asked?.fromRealm) return undefined;
	return answer(
		`Not sent: [${shortId(asked)}] crossed from the ${asked.fromRealm} realm, and nothing said on the mesh reaches back there, so it can't be answered. If it needs an answer, tell the person in your reply.`,
		{ sent: false } satisfies SendDetails,
	);
}

/**
 * Send into another realm through the machine's node, which alone may
 * carry it, and only along a flow it was told of. Refused here when no
 * flow goes there, and otherwise refused by the node as it says, never
 * dropped without a word. Nothing is written into this realm's mesh.
 */
export async function sendAcross(
	at: Local,
	params: SendParams,
): Promise<Answer> {
	const realm = params.realm?.trim() ?? "";
	// Read before the flows, so `need` never crosses as a peer called
	// NEED: a need is found among this realm's cells alone.
	if (needNamed(params.to ?? "").asked) {
		return answer(
			"Not sent: a need is found among this realm's cells, so it can't cross into another. Name the peers there by address.",
			{ sent: false } satisfies SendDetails,
		);
	}
	const flows = (await at.flows?.()) ?? [];
	if (!flows.includes(realm) || !at.cross) {
		return answer(
			`Not sent: this realm's node has no flow to ${realm}, so nothing sent here reaches it. ${flowsText(flows)}`,
			{ sent: false, refused: [realm] } satisfies SendDetails,
		);
	}
	const to = groupsNamed(params.to ?? "");
	if (to.length === 0) {
		return answer(
			`Not sent: a message to the ${realm} realm goes to peers there by address, and the mesh can't pick them from here. Name them with to.`,
			{ sent: false } satisfies SendDetails,
		);
	}
	const re = params.re ? (messageNamed(at, params.re) ?? params.re) : undefined;
	const refused = crossedAnswerRefused(at, re);
	if (refused) return refused;
	// Across a realm a cause told as fact is passed on as fact all the
	// same, so it is judged as a send here is. A hold must arrive on time,
	// so it goes unjudged; an end can't cross, so none is one here.
	const untested =
		params.intent === "hold"
			? undefined
			: await untestedRefusal(at, params, realm, to);
	if (untested !== undefined) {
		return answer(`Not sent: ${untested}`, {
			sent: false,
		} satisfies SendDetails);
	}
	const sent = await at.cross({
		realm,
		from: at.peer.signature,
		to,
		intent: params.intent,
		text: params.text,
		...(re ? { re } : {}),
	});
	if (!sent.ok) {
		return answer(`Not sent: the node refused it (${sent.code}): ${sent.why}`, {
			sent: false,
			crossRefused: { code: sent.code, why: sent.why },
		} satisfies SendDetails);
	}
	const { crossed } = sent;
	const left = [
		params.supersedes ? "supersedes" : "",
		params.endsHold ? "endsHold" : "",
	].filter(Boolean);
	const notes = [
		`It went to the ${realm} realm through this machine's node, and no copy is kept here.`,
		crossed.intent === "question"
			? "Nothing there can answer it on the mesh, so wait on no answer."
			: "",
		left.length > 0
			? `${left.join(" and ")} can't cross, so ${left.length === 1 ? "it was" : "they were"} left out.`
			: "",
	].filter(Boolean);
	return answer(
		`Sent to the ${realm} realm as ${crossed.from}: [${shortId(crossed)}] ${crossed.intent} to ${crossed.to.join(", ")}: ${crossed.text}\n${notes.join(" ")}`,
		{ sent: true, crossed } satisfies SendDetails,
	);
}

/** Which realms this one may send to, as a refusal says it. */
function flowsText(flows: readonly string[]): string {
	return flows.length === 0
		? "Its node lets it send to no other realm."
		: `Its node lets it send to ${flows.join(" and ")}: pass that as realm, with the peers there by address.`;
}

/**
 * The id a message was named by, as written: looked for among the last
 * hours' first, since that is where nearly every answer's question is,
 * and in the whole week only when not found there.
 */
function messageNamed(at: Local, written: string): string | undefined {
	return (
		idNamed(written, at.transport.recentIds()) ??
		idNamed(written, at.transport.ids())
	);
}

/**
 * Why a text may not go for stating an untested cause as settled, under
 * the `untested-cause` guard's mode, or nothing. Sent again unchanged, a
 * redirected text goes, and the person is shown it was let through.
 * The send stands for the call (the realm and the groups the caller
 * fixed, by naming, replacing or answering, its intent, what it answers
 * and its text), not the reason, since the classifier may quote other
 * parts of the same text the second time. Where routing chose the
 * groups it stands for none, since routing may choose others the second
 * time.
 */
async function untestedRefusal(
	at: Local,
	params: SendParams,
	realm: string,
	reaching: readonly string[],
): Promise<string | undefined> {
	const found = at.untested ? await at.untested(params.text) : [];
	if (found.length === 0) return undefined;
	const verdict = refusalUnder(
		GUARDS.untestedCause.name,
		{ block: true, reason: untestedCauseReason(found) },
		"A mesh message stating an untested cause",
		[
			realm,
			[...reaching].sort().join(","),
			params.intent,
			params.re ?? "",
			params.text,
		].join("\n"),
		GUARDS.untestedCause.name,
	);
	return verdict?.reason;
}

export async function send(at: Local, params: SendParams): Promise<Answer> {
	const self = { addresses: at.peer.addresses, ...senderIdentity() };
	const reNamed = params.re ? messageNamed(at, params.re) : undefined;
	// Left without re, a holder's note about its own hold leaves it held.
	const kept = ownHoldKept(at, reNamed, params.endsHold, self);
	const answersNamed = kept ? undefined : reNamed;
	const crossedAnswer = crossedAnswerRefused(at, answersNamed);
	if (crossedAnswer) return crossedAnswer;

	const supersedes = params.supersedes
		? messageNamed(at, params.supersedes)
		: undefined;
	const replaced = supersedes ? at.transport.read(supersedes) : undefined;
	// A send is not refused for a field that doesn't hold: that is left
	// out and said, and the message goes on without it.
	const ownReplaced = replaced && sentBy(replaced, self) ? replaced : undefined;
	const intent = answeringIntent(
		params.intent,
		kept ?? (answersNamed ? at.transport.read(answersNamed) : undefined),
		self,
		ownReplaced,
	);
	// An orchestrator's order to its sessions, as a pivot or a question,
	// says whose limit it puts on a verdict (lib/orchestration/unasked-limits.ts).
	// It is read from the words alone, so before the person is asked to
	// confirm a hold's end, which a refusal would throw away.
	const limits =
		at.peer.orchestrates !== undefined &&
		(params.intent === "pivot" || intent.intent === "question")
			? limitsRefusal(params.text)
			: undefined;
	if (limits !== undefined) {
		return answer(`Not sent: ${limits}`, {
			sent: false,
		} satisfies SendDetails);
	}
	const ended = endedOnWord(at, params.endsHold, answersNamed);
	const needed = await needRead(at, params);
	if ("refused" in needed) return needed.refused;
	// Only a send naming the word asks who is above, since a quest with
	// no mark finds its hub from use over the node. A send can wait for
	// the node, so it finds the hub afresh rather than reading the one
	// this peer keeps, which may be minutes old, unless the node gives it
	// no answer in time. `person` reaches the steward, or reads as
	// `orchestrator` while no steward is set, so it is read first. The
	// steward's own session tells the person in its reply, so the word
	// reaches nobody from it rather than its orchestrator.
	const steward = at.peer.stewardedBy;
	const stewarding = at.peer.stewards !== undefined;
	const rest = stewarding ? personLeftOut(needed.to) : needed.to;
	if (rest === undefined) {
		return answer(
			"Not sent: your quest is the person's steward, so `person` names nobody past you. Tell the person in your reply.",
			{ sent: false } satisfies SendDetails,
		);
	}
	const written = personNamed(rest, steward);
	const fresh = namesOrchestrator(written) ? await findAbove(at) : undefined;
	if (fresh?.settled === true) at.nodeAnswered?.();
	const found = fresh === undefined ? undefined : orKept(fresh, at.keptHub);
	const above = found?.above;
	const orchestrator =
		above === undefined
			? at.peer.orchestratedBy
			: "address" in above
				? above.address
				: undefined;
	const named = groupsNamed(orchestratorNamed(written, orchestrator).to);
	const unnamed = named.filter((group) => groupNamed(group) === undefined);
	const nobody =
		above !== undefined && "none" in above ? above.none : undefined;
	// Meant for one recipient that is not there, with nothing that can be
	// a group beside it: routed by rule, it would land in a group that
	// may have nobody listening.
	if (nobody !== undefined && named.every((group) => unnamed.includes(group))) {
		return answer(
			`Not sent: ${nobody}. Tell the person in your reply, or name the peers it is for by address.`,
			{ sent: false } satisfies SendDetails,
		);
	}
	const said = [
		rest !== needed.to
			? "`person` was left out, since your quest is the person's steward: tell the person in your reply"
			: "",
		steward !== undefined && written !== rest
			? `\`person\` was read as ${steward}, the person's steward, which carries only what needs the person`
			: "",
		nobody !== undefined
			? `${nobody}, so \`orchestrator\` reached nobody and was left out`
			: "",
		above !== undefined && "by" in above && above.by === "use"
			? found?.kept === true
				? `\`orchestrator\` was read as ${above.address}, the hub from use this peer last found: the node gave no answer it could use in time to find it afresh, and as only an address it grants nothing an orchestrator's mark does`
				: `\`orchestrator\` was read as ${above.address}, this peer's hub from use: its quest has no orchestrator, and of the live cells on the quests above it, it talks with that one most, and as only an address it grants nothing an orchestrator's mark does`
			: "",
		params.re && !answersNamed
			? `no message has the id ${params.re}, so it answers nothing`
			: "",
		params.supersedes && !replaced
			? `no message has the id ${params.supersedes}, so it replaces nothing`
			: "",
		replaced && !ownReplaced
			? `${params.supersedes} was sent by ${replaced.from}, and only a message's sender may replace it, so it replaces nothing`
			: "",
		unnamed.length > 0
			? `${unnamed.join(", ")} cannot be a group, so it was left out`
			: "",
		ended.why ?? "",
		kept ? keptSaid(kept) : "",
		intent.why ?? "",
	].filter(Boolean);
	const notes: string[] = [
		...(needed.note ? [needed.note] : []),
		...(said.length > 0
			? [
					`${capitalized(said.join("; "))}. mesh_read shows each message's id in brackets.`,
				]
			: []),
	];
	const standing = await peers(at);
	const everyone = standing.present;
	let pivotTo: readonly string[] = [];
	if (params.intent === "pivot") {
		// Read the mark now: an orchestration undone since this session
		// last looked sends nothing.
		at.peer.refresh();
		const pivot = pivotTargets(
			at.peer.orchestrates,
			named.filter((group) => !unnamed.includes(group)),
			everyone,
		);
		if ("refused" in pivot) {
			return answer(`Not sent: ${pivot.refused}.`, {
				sent: false,
			} satisfies SendDetails);
		}
		pivotTo = pivot.to;
	}
	// A question for the person's hands, put to the orchestrator that
	// takes it to him, counts his acts first (joels-hands.ts). One sent
	// to the hub by its address rather than the word counts the same,
	// kept hub or none, so the hub is found for it.
	const forHisHands =
		intent.intent === "question" &&
		(toOrchestrator(named, orchestrator, everyone) ||
			toOrchestrator(named, steward, everyone) ||
			(await toHubByAddress(at, found, named, everyone)));
	const hands = forHisHands ? handsRefusal(params.text) : undefined;
	if (hands !== undefined) {
		return answer(`Not sent: ${hands}`, {
			sent: false,
		} satisfies SendDetails);
	}
	// And an act it asks of him that its record shows done already is
	// refused, as the 19:24 ask on 16 November should have been
	// (lib/orchestration/done-acts.ts). Only a record saying done refuses.
	const done =
		forHisHands && at.doneProbes
			? await doneAlreadyRefusal(params.text, at.doneProbes, Date.now())
			: undefined;
	if (done !== undefined) {
		return answer(`Not sent: ${done}`, {
			sent: false,
		} satisfies SendDetails);
	}
	// The person is asked to confirm a hold's end only once nothing else
	// refuses the send, so his yes is never spent on one that won't go.
	if (ended.hold) {
		const refused = at.confirmEnd
			? await at.confirmEnd(ended.hold, params.text)
			: "nobody here can confirm it is the person's word.";
		if (refused !== undefined) {
			return answer(`Not sent: ${refused}`, {
				sent: false,
			} satisfies SendDetails);
		}
	}
	// A replacement goes wherever what it replaces went, so it reaches
	// everyone who heard that, beside whoever it is now sent to.
	const chosen = [
		...new Set([
			...(ownReplaced?.to ?? []),
			// An end goes wherever the hold went, to everyone it parked.
			...(ended.hold?.to ?? []),
			...named.filter((group) => !unnamed.includes(group)),
			...pivotTo,
		]),
	];
	// A message that opens by naming peers is for them: sent to a group
	// they share, every other member would read it to learn it was not.
	// An answer is left where it was sent, since the group its question
	// went to sees by it that the question is answered, and a replacement
	// must reach everyone who heard what it replaces.
	// A pivot goes where it was checked to go, never narrowed to peers
	// named at its start, who may be outside the orchestration.
	const meant =
		params.re === undefined &&
		ownReplaced === undefined &&
		params.intent !== "pivot"
			? namedAtStart(params.text, at.peer.session, everyone).map(homeOf)
			: [];
	// An answer that names nowhere goes back to whoever asked: routed by
	// what it says, a live check's PONG went to #all on 2026-10-25 and
	// never reached the peer waiting on it.
	const asker = answersNamed ? at.transport.read(answersNamed) : undefined;
	if (
		chosen.length === 0 &&
		asker &&
		!sentBy(asker, self) &&
		named.length === 0
	) {
		chosen.push(homeOf(asker.from));
	}
	const aimed =
		meant.length > 0 && !sameGroups(chosen, meant) ? meant : undefined;
	if (aimed) {
		notes.push(
			`It opens by naming ${aimed.map((home) => home.slice(1)).join(", ")}, so it goes to ${aimed.length === 1 ? "that peer" : "those peers"} alone${chosen.length > 0 ? ` rather than ${chosen.join(", ")}` : ""}; open it another way to send it to a group.`,
		);
	}
	const routed =
		chosen.length > 0 || aimed
			? undefined
			: await routeOf(
					{ intent: intent.intent, text: params.text },
					at.peer,
					everyone,
					at.route,
				);
	if (routed) {
		notes.push(
			`It named no group, so it goes to ${routed.to.join(", ")}: ${routed.why}. Name the groups with to to send elsewhere.`,
		);
	}
	// A stop is absolute: a peer that stopped this one is not written to
	// at its home, however the send was meant. It is the one send the
	// mesh refuses, since it is the receiver's to make.
	const stops = stoppedBy(at.peer, everyone);
	const stoppedAt = (group: string) =>
		stops.filter(({ stopper }) =>
			stopper.addresses.map(homeOf).includes(group),
		);
	const meantFor = aimed ?? routed?.to ?? chosen;
	// The machine's group takes only holds and the answers that end them
	// (group.ts). What routing sent there goes to this peer's own work's
	// groups instead; what the sender named there is left out, and with
	// nowhere else to go is refused with where to send it.
	const machineRefused =
		meantFor.includes(ALL) && !machineTakes(intent.intent, asker);
	const ownWork = at.peer.scopes;
	const wanted = !machineRefused
		? meantFor
		: routed && !aimed && chosen.length === 0
			? [...ownWork]
			: meantFor.filter((group) => group !== ALL);
	const instead =
		ownWork.length > 0
			? `this peer's work's ${ownWork.length === 1 ? "group" : "groups"}, ${ownWork.join(", ")}, or to the peers it is for by address`
			: "the peers it is for by address, or a group they share";
	const machineText = `${MACHINE} takes only holds and the answers that end them, since every session on the machine hears it, those on other work too. Send it to ${instead}.`;
	if (machineRefused && wanted.length === 0) {
		// Without re a holder's note is no end, so say why it went.
		const why = kept ? `${capitalized(keptSaid(kept))}. ` : "";
		return answer(`Not sent: ${why}${machineText}`, {
			sent: false,
			refused: [ALL],
		} satisfies SendDetails);
	}
	if (machineRefused) {
		notes.push(
			routedWide(routed, aimed, chosen)
				? `Routing judged it for ${MACHINE}, but ${MACHINE} takes only holds and the answers that end them, so it goes to ${wanted.join(", ")}.`
				: `Not written to ${MACHINE}: ${machineText}`,
		);
	}
	const barred = wanted.filter((group) => stoppedAt(group).length > 0);
	const unbarred = wanted.filter((group) => !barred.includes(group));
	const barredText = () =>
		stopsText(
			stops.filter(({ stopper }) =>
				barred.some((group) => stopper.addresses.map(homeOf).includes(group)),
			),
			" Only it can lift that; until it does, leave it be.",
		);
	if (unbarred.length === 0) {
		return answer(`Not sent: ${barredText()}`, {
			sent: false,
			refused: barred,
		} satisfies SendDetails);
	}
	if (barred.length > 0) {
		notes.push(`Not written to ${barred.join(", ")}: ${barredText()}`);
	}
	// Written to an address nobody here goes by, a message is read by
	// nobody: on 2026-11-01 a methuselah session's findings for sessions
	// in the work realm sat unread while it waited on them.
	// Whoever wrote what this answers goes by its address here, presence
	// or none, as the machine's crossing holds do.
	const unheard = unheardOf(
		unbarred,
		standing,
		asker ? [homeOf(asker.from)] : [],
	);
	const to = unbarred.filter((group) => !unheard.includes(group));
	const flows = unheard.length > 0 ? ((await at.flows?.()) ?? []) : [];
	if (to.length === 0) {
		return answer(`Not sent: ${unheardText(unheard, flows)}`, {
			sent: false,
			refused: unheard,
		} satisfies SendDetails);
	}
	if (unheard.length > 0) {
		notes.push(
			`Not written to ${unheard.join(", ")}: ${unheardText(unheard, flows)}`,
		);
	}
	// A cause stated as settled with no test behind it is passed on as
	// settled, so it is refused before anyone reads it (lib/prose/claims.ts).
	// It is judged after every refusal read from the send itself, so a
	// resend it lets through goes. A hold, or a send ending one by answer
	// or replacement, must arrive on time, so it goes unjudged.
	const onTime =
		intent.intent === "hold" ||
		ownReplaced?.intent === "hold" ||
		(params.endsHold === true && asker?.intent === "hold");
	const untested = onTime
		? undefined
		: await untestedRefusal(at, params, "", aimed ?? chosen);
	if (untested !== undefined) {
		return answer(`Not sent: ${untested}`, {
			sent: false,
		} satisfies SendDetails);
	}
	// Only peers still there count as in a group: one whose every other
	// member has ended is one nobody hears this in until someone joins.
	const empty = to.filter(
		(group) =>
			group.startsWith("#") &&
			group !== ALL &&
			!anyoneElseIn(group, everyone, at.peer),
	);
	if (empty.length > 0) {
		notes.push(
			`Nobody else is in ${empty.join(", ")} yet; mesh_read shows it to whoever joins within the week it is kept.`,
		);
	}
	// Only news answers by default: a question of its own asks, and a
	// hold puts off, so neither is taken for the answer it was not.
	const taken =
		params.re === undefined &&
		supersedes === undefined &&
		(intent.intent === "fyi" || intent.intent === "finding")
			? questionTaken(at, to)
			: undefined;
	const re = answersNamed ?? taken?.id;
	if (taken) {
		notes.push(
			`It answers [${shortId(taken)}], the question this peer took up; name re to say it answers another.`,
		);
	}
	const message = at.transport.send({
		from: at.peer.signature,
		to,
		intent: intent.intent,
		text: params.text,
		...senderIdentity(),
		...(re ? { re } : {}),
		...(supersedes ? { supersedes } : {}),
		...(ended.hold && re === ended.hold.id ? { endsHold: true as const } : {}),
	});
	at.sent(message);
	// A peer reads what it writes to: overnight Skynet listened to one
	// channel while it spoke in others, so an objection there went unheard.
	const reading = to.filter(
		(group) =>
			group.startsWith("#") &&
			group !== ALL &&
			!hears(at.peer.groups, group) &&
			at.peer.join(group),
	);
	const {
		notes: reachNotes,
		reached,
		gone,
	} = reach(
		message,
		standing,
		at.peer,
		at.transport.read,
		at.presences.refusal,
	);
	notes.unshift(...reachNotes);
	const glancing = stops
		.filter(({ stopper }) => reaches(message, stopper, -1))
		// A stopper says its addresses as it likes, and this opens a line.
		.map(({ stopper }) => stopper.addresses.find(isAddress) ?? "A peer");
	if (glancing.length > 0) {
		notes.push(
			`${glancing.join(", ")} stopped this peer, so it sees this as one line and no more.`,
		);
	}
	if (reading.length > 0) {
		notes.push(
			`This peer is in ${reading.join(", ")} now, so it hears the answers.`,
		);
	}
	if (message.intent === "hold") {
		notes.push(
			`It holds for two hours at most: answer [${shortId(message)}] with endsHold, or replace it, when it is over, so whoever waits on it carries on.`,
		);
	}
	const answered = re ? at.transport.read(re) : undefined;
	if (message.endsHold && answered) {
		notes.push(
			`It ends [${shortId(answered)}] on the person's word, and every peer waiting on it gets a turn to carry on.`,
		);
	} else if (
		params.endsHold &&
		answered?.intent === "hold" &&
		sentBy(answered, self)
	) {
		notes.push(
			`It ends [${shortId(answered)}], this peer's own hold, and every peer waiting on it gets a turn to carry on.`,
		);
	} else if (
		answered?.intent === "hold" &&
		!sentBy(answered, { addresses: at.peer.addresses, ...senderIdentity() })
	) {
		notes.push(
			`This peer waits on [${shortId(answered)}] now, and gets a turn to carry on when it ends.`,
		);
	}
	return answer(
		`Sent as ${message.from}: ${heading(message)}.\n${notes.join(" ")}`,
		{
			sent: true,
			message,
			reached,
			gone,
			...(routed ? { routed } : {}),
			...(barred.length > 0 ? { refused: barred } : {}),
		} satisfies SendDetails,
	);
}

/**
 * The question a message answers when its sender did not say: the one
 * question this peer took up in a turn that was asked by a peer it goes
 * to, or in a group it goes to. An answer that names nothing reads to
 * the asker as news, and to every other peer as no answer at all, so
 * each of them goes on to answer it too.
 */
function questionTaken(at: Local, to: readonly string[]): Message | undefined {
	const now = Date.now();
	const meant = (at.board.of(at.peer.session)?.leases ?? [])
		.filter((lease) => lease.kind === "answer" && isCurrent(lease, now))
		.map((lease) => at.transport.read(lease.subject))
		.filter(
			(asked): asked is Message =>
				asked !== undefined &&
				(to.includes(homeOf(asked.from)) ||
					asked.to.some((group) => to.includes(group))),
		);
	return meant.length === 1 ? meant[0] : undefined;
}

/** Why a send leaves out the addresses no session here goes by. */
function unheardText(
	unheard: readonly string[],
	flows: readonly string[] = [],
): string {
	const names = unheard.map((group) => group.slice(1)).join(" or ");
	const elsewhere =
		flows.length > 0
			? `. This realm's node lets it send to ${flows.join(" and ")}: if it is meant for a session there, send it again with realm set to that realm.`
			: "; tell the person in your reply what it was for if it is meant for another realm.";
	return `no session in this realm goes by ${names}, there or ended. Realms are kept apart, so a session in another realm can't be reached from here, and a mistyped address reaches nobody. mesh_groups lists who is here${elsewhere}`;
}

function anyoneElseIn(
	group: string,
	everyone: readonly Presence[],
	peer: Peer,
): boolean {
	return everyone.some(
		(one) => one.session !== peer.session && hears(one.groups, group),
	);
}

/**
 * Every joined group with who is in it among the peers still there,
 * where this peer stands, and who joined groups but has since ended.
 */
function sameGroups(one: readonly string[], other: readonly string[]): boolean {
	return (
		one.length === other.length && one.every((group) => other.includes(group))
	);
}
