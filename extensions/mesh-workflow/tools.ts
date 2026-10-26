/**
 * The mesh's tools: send, read back, join, leave or list groups, and
 * stop a peer reaching this one.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { QueueRecord } from "../../lib/internal/priority/folder.ts";
import { answeringTo, namedAtStart } from "../../lib/mesh/address.ts";
import {
	ALL,
	groupNamed,
	groupsNamed,
	hears,
	homeOf,
	isJoinable,
} from "../../lib/mesh/group.ts";
import { type Board, isCurrent, othersOn } from "../../lib/mesh/lease.ts";
import { type Census, census } from "../../lib/mesh/liveness.ts";
import {
	clock,
	INTENTS,
	line,
	type Message,
	reaches,
	shortId,
} from "../../lib/mesh/message.ts";
import type { Peer } from "../../lib/mesh/peer.ts";
import type { Presence, Presences } from "../../lib/mesh/presence.ts";
import { type Judge, type Route, routeOf } from "../../lib/mesh/routing.ts";
import { stoppedBy } from "../../lib/mesh/stop.ts";
import { idNamed, mayReplace, sentBy } from "../../lib/mesh/thread.ts";
import type { Transport } from "../../lib/mesh/transport.ts";
import type { WantKind } from "../../lib/mesh/want.ts";
import { leasesText } from "./leases.ts";

/**
 * The most messages one mesh_read hands back. Messages are short by
 * request, so this keeps the answer to a few thousand characters.
 */
const MOST_READ = 50;

/** What the tools act through, once the session has started. */
export interface Local {
	readonly peer: Peer;
	readonly transport: Transport;
	readonly presences: Presences;
	/** The leases every peer holds (see lib/mesh/lease.ts). */
	readonly board: Board;
	/** The classifier, for routing a message that names no group. */
	readonly route?: Judge;
	/** The machine queue's jobs, while some session keeps it. */
	readonly queue?: () => QueueRecord["jobs"] | undefined;
	/** Note a message this peer sent, so it is never handed back to it. */
	sent(message: Message): void;
	/**
	 * Ask the person to confirm ending another peer's hold on their word:
	 * why it may not be sent, or nothing once it may (see end-hold.ts).
	 */
	confirmEnd?(hold: Message, text: string): Promise<string | undefined>;
}

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
}

export function registerTools(
	pi: ExtensionAPI,
	local: () => Local | undefined,
): void {
	const using =
		<P>(act: (at: Local, params: P) => Answer | Promise<Answer>) =>
		async (_id: string, params: P) => {
			const at = local();
			if (!at) {
				return answer(
					"This pi is not on the mesh: it keeps no session, runs with PI_MESH=off, or has not started one yet.",
				);
			}
			at.peer.refresh();
			return act(at, params);
		};

	pi.registerTool({
		name: "mesh_send",
		label: "Mesh",
		// The always-visible tool list names only tools with a snippet. Without
		// one a session reading it after a reload concluded it had no mesh
		// tools and went through codemode; one line names the six.
		promptSnippet:
			"Message the other pi sessions on this machine; mesh_read, mesh_groups, mesh_join, mesh_leave and mesh_stop read the mesh and shape who hears what.",
		description:
			"Send a message to other pi sessions (peers) on this machine without interrupting them: it joins their conversation as context, at the attention each gives it. Send only what changes what another peer should do (a hold before a reboot, a switch or a merge; a question only it can answer) or what concerns something it owns (a finding). Never send progress, acknowledgements or thanks, nor word of heavy work: builds, VM tests and benchmarks take turns in the machine's queue by themselves. Every message goes to a group: a peer's home group by its address (5GV2AH); a group a peer's work puts it in, its quest's (#quest/5gv2ah, which reaches the quests under it too) or its repository's (#repo/agentic-harness-pi); a group by name (#harness); or #all, which is only for what touches every peer on the machine. Pick the narrowest that reaches everyone affected: a question for one peer goes to its address alone (to: P9R1KI, not a group it shares), since every member of a group reads what is sent there; a question to several peers or a named group asks each of them, giving each a turn and counting only each one's own answer, while one to #all goes to whoever takes it up; and a message that opens by naming peers ('P9R1KI: may I') goes to them alone wherever it was sent. When the person asks to stop or pause other sessions' work, as before a reboot, send a hold to #all asking each peer to answer it once parked, then answer the hold yourself (re) when work may resume: that hands every peer that answered its turn back, and a reboot since a hold was sent ends it by itself. When the person tells you a hold another peer sent is over, answer it with endsHold, which asks them to confirm. A question or an fyi hands no turn back, so a pause sent as one leaves sessions parked. Leave `to` out and the mesh picks from what the message names and who works on it. Sending to a named group joins it, so this peer hears the answers. mesh_groups lists the groups and who is in them.",
		parameters: Type.Object({
			to: Type.Optional(
				Type.String({
					description:
						"Comma-separated groups: peer addresses such as P9R1KI, groups such as #harness, or all. Leave it out and the mesh picks, saying where and why",
				}),
			),
			intent: StringEnum(INTENTS, {
				description:
					"hold: put off something until you say it is over; question: wants an answer; finding: for whoever owns what it is about, saying what you checked it against; fyi: context only",
			}),
			text: Type.String({
				description: "The message, plain and short, standing on its own",
			}),
			re: Type.Optional(
				Type.String({
					description:
						"The id of the message this answers, as shown in brackets beside it, such as 2f95756a",
				}),
			),
			supersedes: Type.Optional(
				Type.String({
					description:
						"The id of a message this peer sent earlier that this one replaces, to withdraw or correct it; it also goes wherever that one went, so everyone who heard it hears this",
				}),
			),
			endsHold: Type.Optional(
				Type.Boolean({
					description:
						"true only when the person has told you that the hold another peer sent, named by re, is over: it ends that hold for every peer waiting on it, once the person confirms. Never on your own judgement",
				}),
			),
		}),
		execute: using(send),
	});

	pi.registerTool({
		name: "mesh_read",
		label: "Mesh",
		description:
			"Read the latest messages this peer hears on the mesh, and what it sent, to catch up after a reload or compaction, or to read a glance in full.",
		parameters: Type.Object({
			count: Type.Optional(
				Type.Number({
					description: `How many of the latest to show; default 15, at most ${MOST_READ}`,
				}),
			),
		}),
		execute: using(read),
	});

	pi.registerTool({
		name: "mesh_join",
		label: "Mesh",
		description:
			"Join a mesh group, so this peer hears what is sent to it and to the groups it is part of, and bring other peers into it without asking them. This peer is already in its quest's and repository's groups. Join, or make, a group for work shared beyond those (#harness, #optimus/power), not every group there is; join a peer's address to follow its home group.",
		parameters: Type.Object({
			group: Type.String({
				description:
					"A group such as #harness, a part of one such as #optimus/power, or a peer's address. A named group nobody is in yet is made by joining it.",
			}),
			invite: Type.Optional(
				Type.String({
					description:
						"Comma-separated addresses of peers to bring into a named group too; each is told, and is in it from then on until it leaves",
				}),
			),
			why: Type.Optional(
				Type.String({
					description: "What the group is for, said to those invited",
				}),
			),
		}),
		execute: using(join),
	});

	pi.registerTool({
		name: "mesh_leave",
		label: "Mesh",
		description:
			"Leave a mesh group this peer joined and no longer works on, so its messages stop reaching it. The groups its work puts it in are left with the work.",
		parameters: Type.Object({
			group: Type.String({ description: "The group to leave" }),
		}),
		execute: using(leave),
	});

	pi.registerTool({
		name: "mesh_stop",
		label: "Mesh",
		description:
			"Stop a peer reaching this one, when what it sends keeps costing this peer more than it gives. Until this peer lifts it, the stopped peer's messages reach it only as one-line glances, never in full and never as a turn, and its sends to this peer's home group are refused. The stopped peer is told, with why. Only this peer can lift it.",
		parameters: Type.Object({
			peer: Type.String({ description: "The address of the peer to stop" }),
			why: Type.Optional(
				Type.String({ description: "Why, said to the stopped peer" }),
			),
			lift: Type.Optional(
				Type.Boolean({
					description: "Lift a stop this peer set instead of setting one",
				}),
			),
		}),
		execute: using(stop),
	});

	pi.registerTool({
		name: "mesh_groups",
		label: "Mesh",
		description:
			"List the peers on the mesh and what each works on, the groups, who is in each, and which this peer is in, and the leases peers hold: what each is changing, answering, holding or waiting on, and the heavy work it runs or waits its turn for in the machine's queue.",
		parameters: Type.Object({}),
		execute: using(async (at) => {
			const standing = await peers(at);
			return answer(
				`${groupsText(standing, at.peer)}${peersText(standing.present, at.peer)}${leasesText(at.board.all(), standing.present, Date.now(), at.queue?.())}`,
				{ groups: at.peer.groups },
			);
		}),
	});
}

type Answer = ReturnType<typeof answer>;

/**
 * Every peer, answering only to its own addresses, sorted by whether
 * it is still on the mesh.
 */
function peers(at: Local): Promise<Census> {
	const everyone = at.presences.all();
	return census(
		everyone.map((one) => ({
			...one,
			addresses: answeringTo(one, everyone),
		})),
	);
}

/**
 * The hold a send ends on the person's word, or why it ends none: only
 * another peer's hold can be, since answering its own ends it already.
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
	if (sentBy(hold, { addresses: at.peer.addresses, pid: process.pid })) {
		return {
			why: `[${shortId(hold)}] is this peer's own hold, which answering ends already, so endsHold was left out`,
		};
	}
	return { hold };
}

async function send(
	at: Local,
	params: {
		to?: string;
		intent: Message["intent"];
		text: string;
		re?: string;
		supersedes?: string;
		endsHold?: boolean;
	},
): Promise<Answer> {
	const ids = at.transport.ids();
	const answersNamed = params.re ? idNamed(params.re, ids) : undefined;
	const ended = endedOnWord(at, params.endsHold, answersNamed);
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
	const supersedes = params.supersedes
		? idNamed(params.supersedes, ids)
		: undefined;
	const replaced = supersedes ? at.transport.read(supersedes) : undefined;
	const self = { addresses: at.peer.addresses, pid: process.pid };
	// A send is never refused for how it was written: what does not hold
	// is left out and said, and the message goes on without it.
	const ownReplaced = replaced && sentBy(replaced, self) ? replaced : undefined;
	const named = groupsNamed(params.to ?? "");
	const unnamed = named.filter((group) => groupNamed(group) === undefined);
	const said = [
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
	].filter(Boolean);
	const notes: string[] =
		said.length > 0
			? [
					`${capitalized(said.join("; "))}. mesh_read shows each message's id in brackets.`,
				]
			: [];
	const standing = await peers(at);
	const everyone = standing.present;
	// A replacement goes wherever what it replaces went, so it reaches
	// everyone who heard that, beside whoever it is now sent to.
	const chosen = [
		...new Set([
			...(ownReplaced?.to ?? []),
			// An end goes wherever the hold went, to everyone it parked.
			...(ended.hold?.to ?? []),
			...named.filter((group) => !unnamed.includes(group)),
		]),
	];
	// A message that opens by naming peers is for them: sent to a group
	// they share, every other member would read it to learn it was not.
	// An answer is left where it was sent, since the group its question
	// went to sees by it that the question is answered, and a replacement
	// must reach everyone who heard what it replaces.
	const meant =
		params.re === undefined && ownReplaced === undefined
			? namedAtStart(params.text, at.peer.session, everyone).map(homeOf)
			: [];
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
					{ intent: params.intent, text: params.text },
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
	const wanted = aimed ?? routed?.to ?? chosen;
	const barred = wanted.filter((group) => stoppedAt(group).length > 0);
	const to = wanted.filter((group) => !barred.includes(group));
	const barredText = () =>
		`${stopsText(stops.filter(({ stopper }) => barred.some((group) => stopper.addresses.map(homeOf).includes(group))))} Only it can lift that; until it does, leave it be.`;
	if (to.length === 0) {
		return answer(`Not sent: ${barredText()}`, {
			sent: false,
			refused: barred,
		} satisfies SendDetails);
	}
	if (barred.length > 0) {
		notes.push(`Not written to ${barred.join(", ")}: ${barredText()}`);
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
	const taken =
		params.re === undefined &&
		supersedes === undefined &&
		params.intent !== "hold"
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
		intent: params.intent,
		text: params.text,
		pid: process.pid,
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
	} = reach(message, standing, at.peer);
	notes.unshift(...reachNotes);
	const glancing = stops
		.filter(({ stopper }) => reaches(message, stopper, -1))
		.map(({ stopper }) => stopper.addresses[0]);
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
			`It holds for two hours at most: answer or replace [${shortId(message)}] when it is over, so whoever waits on it carries on.`,
		);
	}
	const answered = re ? at.transport.read(re) : undefined;
	if (message.endsHold && answered) {
		notes.push(
			`It ends [${shortId(answered)}] on the person's word, and every peer waiting on it gets a turn to carry on.`,
		);
	} else if (
		answered?.intent === "hold" &&
		!sentBy(answered, { addresses: at.peer.addresses, pid: process.pid })
	) {
		notes.push(
			`This peer waits on [${shortId(answered)}] now, and gets a turn to carry on when it ends.`,
		);
	}
	return answer(
		`Sent as ${message.from}: ${line(message)}\n${notes.join(" ")}`,
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

/** Who a message just sent goes to, and which addressed peers it misses. */
function reach(
	message: Message,
	standing: Census,
	peer: Peer,
): { notes: string[]; reached: string[]; gone: string[] } {
	const everyone = standing.present;
	const reached = everyone
		.filter((one) => one.session !== peer.session && one.addresses.length > 0)
		.filter((one) => reaches(message, one, -1))
		.map((one) => one.addresses[0] as string);
	const homes = (list: readonly Presence[]) =>
		new Set(list.flatMap((one) => one.addresses.map(homeOf)));
	const there = homes(everyone);
	const ended = homes(standing.gone);
	const addressed = message.to.filter((group) => group.startsWith("@"));
	const gone = addressed
		.filter((group) => !there.has(group) && ended.has(group))
		.map((group) => group.slice(1));
	const unknown = addressed
		.filter((group) => !there.has(group) && !ended.has(group))
		.map((group) => group.slice(1));
	// Waited on as though it were free to answer, it would hold its asker up.
	const waiting = everyone.flatMap((one) =>
		one.session !== peer.session &&
		one.wants &&
		one.addresses[0] &&
		one.addresses.some((address) => addressed.includes(homeOf(address)))
			? [
					`${one.addresses[0]} (${WANTING[one.wants.kind]} since ${clock({ at: one.wants.since })})`,
				]
			: [],
	);
	const notes = [
		reached.length > 0
			? `It goes to ${reached.join(", ")}; mesh_read says when each has it.`
			: "No peer on the mesh is reached by it yet.",
		gone.length > 0
			? `${gone.join(", ")} ${gone.length === 1 ? "has" : "have"} ended, so ${gone.length === 1 ? "it hears" : "they hear"} this only if restored.`
			: "",
		unknown.length > 0
			? `No peer goes by ${unknown.join(", ")}; one never will if the address is wrong.`
			: "",
		waiting.length > 0
			? `${waiting.join(" and ")} ${waiting.length === 1 ? "is waiting on its person, so it" : "are waiting on their people, so they"} may be slow to take this up.`
			: "",
	].filter(Boolean);
	return { notes, reached, gone };
}

async function read(at: Local, params: { count?: number }): Promise<Answer> {
	const wanted = Math.min(
		MOST_READ,
		Math.max(1, Math.floor(params.count ?? 15)),
	);
	// Newest first, reading only until enough are found: what is shown,
	// not the mesh's whole week.
	const ids = at.transport.ids();
	const latest: Message[] = [];
	for (let index = ids.length - 1; index >= 0; index--) {
		if (latest.length >= wanted) break;
		const message = at.transport.read(ids[index] as string);
		if (
			message &&
			(message.pid === process.pid ||
				at.peer.addresses.includes(message.from) ||
				reaches(message, at.peer.listener, -1))
		) {
			latest.unshift(message);
		}
	}
	const present = (await peers(at)).present;
	const receipt = receipts(at, present);
	const withdrawn = withdrawals(latest);
	const state = questionStates(at, latest, ids, present, withdrawn);
	const text =
		latest.length > 0
			? latest
					.map((message) =>
						[
							line(message),
							withdrawn.get(message.id) ?? "",
							receipt(message),
							state.get(message.id) ?? "",
						]
							.filter(Boolean)
							.join("\n  "),
					)
					.join("\n")
			: "Nothing on the mesh yet.";
	return answer(`This peer is ${at.peer.addresses.join(" or ")}.\n${text}`);
}

/**
 * Where each of this peer's own questions among these stands: answered,
 * and by whom; being answered, by a peer that took it up; or unanswered,
 * and for how long. A question nobody answers otherwise reads the same
 * as one answered in a group the asker never looked at.
 */
function questionStates(
	at: Local,
	shown: readonly Message[],
	ids: readonly string[],
	present: readonly Presence[],
	withdrawn: ReadonlyMap<string, string>,
): Map<string, string> {
	const self = { addresses: at.peer.addresses, pid: process.pid };
	const asked = shown.filter(
		(message) =>
			message.intent === "question" &&
			sentBy(message, self) &&
			!withdrawn.has(message.id),
	);
	const states = new Map<string, string>();
	const first = asked[0]?.id;
	if (first === undefined) return states;
	// Only what came after the oldest question can answer one.
	const answers = new Map<string, Message[]>();
	for (const id of ids) {
		if (id <= first) continue;
		const one = at.transport.read(id);
		if (one?.re === undefined || sentBy(one, self)) continue;
		answers.set(one.re, [...(answers.get(one.re) ?? []), one]);
	}
	const now = Date.now();
	const board = at.board.all();
	for (const question of asked) {
		const given = answers.get(question.id) ?? [];
		if (given.length > 0) {
			const by = [...new Set(given.map((one) => one.from))].join(", ");
			const last = given.at(-1) as Message;
			states.set(question.id, `answered by ${by}, last in [${shortId(last)}]`);
			continue;
		}
		const answering = othersOn(
			board,
			at.peer.session,
			"answer",
			question.id,
			now,
		)
			.map(
				(held) =>
					present.find((one) => one.session === held.session)?.addresses[0],
			)
			.filter((address): address is string => address !== undefined);
		states.set(
			question.id,
			answering.length > 0
				? `being answered by ${answering.join(", ")}`
				: `unanswered after ${since(question, now)}`,
		);
	}
	return states;
}

/** How long ago a message was sent, in minutes, or hours past two. */
function since(message: Message, now: number): string {
	const minutes = Math.max(
		0,
		Math.floor((now - Date.parse(message.at)) / 60_000),
	);
	return minutes < 120 ? `${minutes} min` : `${Math.floor(minutes / 60)} h`;
}

/**
 * The messages among these that a later one replaced, each with the
 * line that says so, so a withdrawn message is never read as standing.
 */
function withdrawals(messages: readonly Message[]): Map<string, string> {
	const byId = new Map(messages.map((one) => [one.id, one]));
	const withdrawn = new Map<string, string>();
	for (const one of messages) {
		const original = one.supersedes ? byId.get(one.supersedes) : undefined;
		if (original && mayReplace(one, original)) {
			withdrawn.set(
				original.id,
				`withdrawn: replaced by [${shortId(one)}], so go by that instead`,
			);
		}
	}
	return withdrawn;
}

/**
 * Who has a message this peer sent, and who it is still on its way to,
 * among the peers still there. A peer has it once its read marker has
 * passed it, which happens when the message is handed to its model,
 * at whatever attention; a peer mid-run gets it at its next step.
 */
function receipts(
	at: Local,
	present: readonly Presence[],
): (message: Message) => string {
	const marks = new Map<string, string | undefined>();
	const markOf = (one: Presence) => {
		if (!marks.has(one.session)) {
			marks.set(one.session, at.transport.lastRead(one.addresses));
		}
		return marks.get(one.session);
	};
	return (message) => {
		const own =
			message.pid === process.pid || at.peer.addresses.includes(message.from);
		if (!own) return "";
		const meant = present.filter(
			(one) =>
				one.session !== at.peer.session &&
				one.addresses.length > 0 &&
				reaches(message, one, -1),
		);
		if (meant.length === 0) return "reached no peer";
		const signed = (list: readonly Presence[]) =>
			list.map((one) => one.addresses[0]).join(", ");
		const has = meant.filter((one) => (markOf(one) ?? "") >= message.id);
		const waiting = meant.filter((one) => !has.includes(one));
		return [
			has.length > 0
				? `${signed(has)} ${has.length === 1 ? "has" : "have"} it`
				: "",
			waiting.length > 0 ? `not yet ${signed(waiting)}` : "",
		]
			.filter(Boolean)
			.join("; ");
	};
}

async function join(
	at: Local,
	params: { group: string; invite?: string; why?: string },
): Promise<Answer> {
	const group = joinable(params.group, at.presences.all());
	if (group === undefined || !isJoinable(group)) {
		return answer(
			`${params.group} is not a group to join: name one with letters, digits and dashes after a #, with / between a group and its part, as #optimus/power, or give a peer's address. Every peer is in #all already.`,
		);
	}
	if (at.peer.addresses.map(homeOf).includes(group)) {
		return answer(
			`${group} is this peer's own home group; it is always in it.`,
		);
	}
	const already =
		hears(at.peer.scopes, group) && !at.peer.joined.includes(group);
	const joinedNow = !already && at.peer.join(group);
	const standing = await peers(at);
	const said = already
		? `Already in ${group} by this peer's work.`
		: `In ${group}.`;
	const invited = groupsNamed(params.invite ?? "");
	const lately = joinedNow ? saidLately(at, group) : "";
	if (invited.length === 0) {
		return answer(`${said} ${groupsText(standing, at.peer)}${lately}`, {
			groups: at.peer.groups,
		});
	}
	if (!group.startsWith("#")) {
		return answer(
			`${said} Nobody was invited: peers are brought into a named group, and anyone may follow a home group by joining it.`,
			{ groups: at.peer.groups },
		);
	}
	const homes = invited.filter(
		(one) =>
			one.startsWith("@") && !at.peer.addresses.map(homeOf).includes(one),
	);
	const notHomes = invited.filter((one) => !homes.includes(one));
	if (homes.length === 0) {
		return answer(
			`${said} Nobody was invited: ${notHomes.join(", ")} names no other peer. Invite peers by their addresses, as P9R1KI.`,
			{ groups: at.peer.groups },
		);
	}
	const why = params.why?.trim();
	const message = at.transport.send({
		from: at.peer.signature,
		to: homes,
		intent: "fyi",
		text: `${at.peer.signature} brings this peer into ${group}${why ? `: ${why}` : "."} It is in ${group} from now on, hearing what is said there, until it leaves with mesh_leave.`,
		pid: process.pid,
		invite: group,
	});
	at.sent(message);
	const { notes } = reach(message, standing, at.peer);
	const skipped =
		notHomes.length > 0
			? ` Not invited, since they name no other peer: ${notHomes.join(", ")}.`
			: "";
	return answer(
		`${said} Invited ${homes.map((one) => one.slice(1)).join(", ")}. ${notes.join(" ")}${skipped}${lately}`,
		{ groups: at.peer.groups, invited: homes, message },
	);
}

/** How many of a group's latest messages joining it shows. */
const LATELY = 10;

/** How much of each of those it shows. */
const LATELY_CHARS = 240;

/**
 * What was said in a group lately, oldest first, so a peer joining it
 * starts from where its talk stands rather than from silence.
 */
function saidLately(at: Local, group: string): string {
	const ids = at.transport.ids();
	const latest: string[] = [];
	for (let index = ids.length - 1; index >= 0; index--) {
		if (latest.length >= LATELY) break;
		const message = at.transport.read(ids[index] as string);
		if (!message?.to.includes(group)) continue;
		const whole = line(message).replace(/\s+/g, " ");
		latest.unshift(
			whole.length > LATELY_CHARS
				? `${whole.slice(0, LATELY_CHARS - 3)}...`
				: whole,
		);
	}
	return latest.length > 0
		? `\nSaid in ${group} lately, oldest first (mesh_read has each in full):\n${latest.join("\n")}`
		: "";
}

async function leave(at: Local, params: { group: string }): Promise<Answer> {
	const group = groupNamed(params.group);
	const left = group !== undefined && at.peer.leave(group);
	const everyone = await peers(at);
	const scoped = group !== undefined && at.peer.scopes.includes(group);
	const said = scoped
		? `${left ? `Left what this peer joined of ${group}, but it` : group} is one of this peer's scopes: its work puts it there, so it hears ${group} until it works on something else.`
		: left
			? `Left ${group}.`
			: `Not in ${params.group}, so nothing changed.`;
	return answer(`${said} ${groupsText(everyone, at.peer)}`, {
		groups: at.peer.groups,
	});
}

/**
 * The group a peer means to join. A bare name is a peer's address when
 * some peer goes by it, and otherwise a named group, since "harness"
 * typed without its # means #harness.
 */
function joinable(
	written: string,
	everyone: readonly Presence[],
): string | undefined {
	const group = groupNamed(written);
	const bare = !/^[#@]/.test(written.trim());
	if (!bare || group === undefined || !group.startsWith("@")) return group;
	const known = everyone.some((one) =>
		one.addresses.map(homeOf).includes(group),
	);
	return known ? group : groupNamed(`#${written.trim()}`);
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

function capitalized(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

function groupsText(standing: Census, peer: Peer): string {
	const members = new Map<string, string[]>();
	for (const one of standing.present) {
		const signature = one.addresses[0];
		if (!signature) continue;
		const groups = one.session === peer.session ? peer.groups : one.groups;
		for (const group of groups) {
			members.set(group, [...(members.get(group) ?? []), signature]);
		}
	}
	const lines = [...members.keys()]
		.sort()
		.map((group) => `${group}: ${members.get(group)?.join(", ")}`);
	const joined = peer.joined.filter((group) => !peer.scopes.includes(group));
	const standsIn = [
		peer.scopes.length > 0 ? `is in ${peer.scopes.join(", ")} by its work` : "",
		joined.length > 0 ? `has joined ${joined.join(", ")}` : "",
	].filter(Boolean);
	const own =
		standsIn.length > 0
			? `This peer ${standsIn.join(", and ")}; it is also in its home group and #all.`
			: "This peer is in its home group and #all only.";
	// An address a live session answers to again (a quest's peer restarted
	// under a new session) has not ended, so it is not listed as ended.
	const answering = new Set(
		standing.present.flatMap((one) => one.addresses.slice(0, 1)),
	);
	const ended = [
		...new Set(
			standing.gone
				.filter((one) => one.groups.length > 0 && one.addresses[0])
				.map((one) => one.addresses[0] as string)
				.filter((address) => !answering.has(address)),
		),
	];
	const gone =
		ended.length > 0
			? `\nEnded, so left out until restored: ${ended.join(", ")}.`
			: "";
	const stopping =
		peer.stops.length > 0
			? `\nStopped by this peer: ${peer.stops.map((one) => one.address).join(", ")}.`
			: "";
	const stops = stoppedBy(peer, standing.present);
	const stoppedHere = stops.length > 0 ? `\n${stopsText(stops)}` : "";
	const waiting = wantsText(standing.present);
	const more = `${gone}${stopping}${stoppedHere}${waiting}`;
	return lines.length > 0
		? `${own}\nGroups:\n${lines.join("\n")}${more}`
		: `${own} No other groups yet.${more}`;
}

/** How much of what a peer works on mesh_groups says, to name it. */
const WORK_CHARS = 100;

/**
 * Every other peer still there, one line each: whether it is in a run,
 * and what it works on, so a peer can tell whom to ask without asking.
 */
function peersText(present: readonly Presence[], peer: Peer): string {
	const lines = present.flatMap((one) => {
		const address = one.addresses[0];
		if (one.session === peer.session || !address) return [];
		const work = one.worksOn.replace(/\s+/g, " ").trim();
		const cut =
			work.length > WORK_CHARS ? `${work.slice(0, WORK_CHARS - 3)}...` : work;
		return [`${address}, ${one.busy ? "busy" : "idle"}: ${cut}`];
	});
	return lines.length > 0 ? `\nPeers:\n${lines.join("\n")}` : "";
}

/**
 * The peers waiting on their person, so none is waited on as though it
 * were free to answer (see want.ts).
 */
function wantsText(present: readonly Presence[]): string {
	const lines = present.flatMap((one) =>
		one.wants && one.addresses[0]
			? [
					`${one.addresses[0]}: ${WANTING[one.wants.kind]} since ${clock({ at: one.wants.since })}: ${one.wants.said}`,
				]
			: [],
	);
	return lines.length > 0
		? `\nWaiting on their person:\n${lines.join("\n")}`
		: "";
}

/** A want's kind, as mesh_groups says it. */
const WANTING: Record<WantKind, string> = {
	question: "asked",
	approval: "held at an approval",
	blocked: "blocked",
};

/** The stops on this peer, said to it. */
function stopsText(stops: ReturnType<typeof stoppedBy>): string {
	return stops
		.map(
			({ stopper, stop }) =>
				`${stopper.addresses[0]} stopped this peer reaching it${stop.why ? ` (${stop.why})` : ""}: it sees what this peer sends as one line only.`,
		)
		.join(" ");
}

async function stop(
	at: Local,
	params: { peer: string; why?: string; lift?: boolean },
): Promise<Answer> {
	const everyone = at.presences.all();
	const home = groupNamed(params.peer);
	const address = home?.startsWith("@") ? home.slice(1) : undefined;
	if (!address || at.peer.addresses.includes(address)) {
		return answer(
			`${params.peer} is not another peer's address; give one as mesh_groups lists it, such as P9R1KI.`,
		);
	}
	const why = params.why?.trim();
	const stopped = everyone.find((one) => one.addresses.includes(address));
	// Whichever of its addresses it is named by, a peer has one stop.
	const standing = at.peer.stops.find(
		(one) =>
			one.address === address ||
			(stopped !== undefined && one.session === stopped.session),
	);
	if (params.lift) {
		if (!standing) {
			return answer(`${address} is not stopped, so nothing changed.`);
		}
		at.peer.lift(standing.address);
		tell(
			at,
			address,
			`${at.peer.signature} has lifted its stop on this peer, which may reach it again as any peer does.`,
		);
		return answer(`Lifted the stop on ${address}; it is told.`);
	}
	if (standing) return answer(`${address} is stopped already.`);
	const set = at.peer.stop({
		address,
		at: new Date().toISOString(),
		...(stopped ? { session: stopped.session } : {}),
		...(why ? { why } : {}),
	});
	if (!set) return answer(`${address} is stopped already.`);
	tell(
		at,
		address,
		`${at.peer.signature} has stopped this peer reaching it${why ? `: ${why}` : "."} Until it lifts the stop, it sees what this peer sends as one line only, and sends to its home group are refused. Do not work around it.`,
	);
	return answer(
		`Stopped ${address}: what it sends reaches this peer as one line only, its answers to this peer's questions included, until mesh_stop with lift. It is told${why ? ", with why" : ""}.`,
	);
}

/** Say something to one peer's home group, as the mesh itself would. */
function tell(at: Local, address: string, text: string): void {
	const message = at.transport.send({
		from: at.peer.signature,
		to: [homeOf(address)],
		intent: "fyi",
		text,
		pid: process.pid,
	});
	at.sent(message);
}

function answer(text: string, details: unknown = {}) {
	return { content: [{ type: "text" as const, text }], details };
}
