/**
 * mesh_join, mesh_leave and mesh_groups: the groups a peer is in, who
 * else is, what each peer is doing, and whom this one is tied to.
 */

import { isId, prefixOf } from "../../../lib/internal/quest/creation/id.ts";
import { isAddress } from "../../../lib/mesh/address.ts";
import {
	groupNamed,
	groupsNamed,
	hears,
	homeOf,
	isJoinable,
	MOST_GROUP_CHARS,
} from "../../../lib/mesh/group.ts";
import type { Census } from "../../../lib/mesh/liveness.ts";
import { clock, line, senderIdentity } from "../../../lib/mesh/message.ts";
import type { Tie } from "../../../lib/mesh/node.ts";
import { isName, oneLine } from "../../../lib/mesh/one-line.ts";
import type { Peer } from "../../../lib/mesh/peer.ts";
import {
	joinRefused,
	MOST_GROUPS,
	type Presence,
} from "../../../lib/mesh/presence.ts";
import { stoppedBy } from "../../../lib/mesh/stop.ts";
import { type Answer, answer, type Local, peers } from "./local.ts";
import { reach } from "./reach.ts";
import { lastedText, WANTING } from "./said.ts";
import { stopsText } from "./stop.ts";

export async function join(
	at: Local,
	params: { group: string; invite?: string; why?: string },
): Promise<Answer> {
	const group = joinable(params.group, at.presences.all());
	if (group === undefined || !isJoinable(group)) {
		return answer(
			`${params.group} is not a group to join: name one of at most ${MOST_GROUP_CHARS} characters with letters, digits and dashes after a #, with / between a group and its part, as #optimus/power, or give a peer's address. Every peer is in #machine already.`,
		);
	}
	const refused = joinRefused(at.peer.groups, group);
	if (refused === "full") {
		return answer(
			`Not in ${group}: this peer is in ${at.peer.groups.length} groups, the most a peer may be in. Leave one it no longer works on first. ${LISTED_IN_GROUPS}`,
			{ groups: at.peer.groups },
		);
	}
	if (at.peer.addresses.map(homeOf).includes(group)) {
		return answer(
			`${group} is this peer's own home group; it is always in it.`,
		);
	}
	const already =
		hears(at.peer.scopes, group) && !at.peer.joined.includes(group);
	const heard = !already && refused === "heard";
	const joinedNow = !already && !heard && at.peer.join(group);
	const standing = listable(await peers(at));
	const said = already
		? `Already in ${group} by this peer's work.`
		: heard
			? `Already hears ${group} through a group under it, so it was not joined: this peer is in ${at.peer.groups.length} groups, the most a peer may be in.`
			: `In ${group}.`;
	const invited = groupsNamed(params.invite ?? "");
	const lately = joinedNow ? await saidLately(at, group) : "";
	if (invited.length === 0) {
		return answer(
			`${said} ${standsText(at.peer)} ${membersText(standing, at.peer, group)} ${LISTED_IN_GROUPS}${lately}`,
			{
				groups: at.peer.groups,
			},
		);
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
	// A peer already in the most groups would refuse the invite, which
	// says it is in the group from now on, so none is sent it.
	const full = homes.filter((home) =>
		standing.present.some(
			(one) =>
				one.addresses.map(homeOf).includes(home) &&
				joinRefused(one.groups, group) === "full",
		),
	);
	const fullText =
		full.length > 0
			? ` Not invited, since ${full.length === 1 ? "it is" : "each is"} in ${MOST_GROUPS} groups, the most a peer may be in: ${full.map((one) => one.slice(1)).join(", ")}. Invite ${full.length === 1 ? "it" : "each"} again once it has left one.`
			: "";
	const skipped =
		notHomes.length > 0
			? ` Not invited, since they name no other peer: ${notHomes.join(", ")}.`
			: "";
	const sendable = homes.filter((home) => !full.includes(home));
	if (homes.length > 0 && sendable.length === 0) {
		return answer(`${said} Nobody was invited.${fullText}${skipped}${lately}`, {
			groups: at.peer.groups,
		});
	}
	if (homes.length === 0) {
		return answer(
			`${said} Nobody was invited: ${notHomes.join(", ")} names no other peer. Invite peers by their addresses, as P9R1KI.`,
			{ groups: at.peer.groups },
		);
	}
	const why = params.why?.trim();
	const message = at.transport.send({
		from: at.peer.signature,
		to: sendable,
		intent: "fyi",
		text: `${at.peer.signature} brings this peer into ${group}${why ? `: ${why}` : "."} It is in ${group} from now on, hearing what is said there, until it leaves with mesh_leave.`,
		...senderIdentity(),
		invite: group,
	});
	at.sent(message);
	const { notes } = reach(
		message,
		standing,
		at.peer,
		at.transport.read,
		at.presences.refusal,
	);
	return answer(
		`${said} Invited ${sendable.map((one) => one.slice(1)).join(", ")}. ${notes.join(" ")}${fullText}${skipped}${lately}`,
		{ groups: at.peer.groups, invited: sendable, message },
	);
}

/** How many of a group's latest messages joining it shows. */
const LATELY = 10;

/** How much of each of those it shows. */
const LATELY_CHARS = 240;

/**
 * What was said in a group lately, oldest first, so a peer joining it
 * starts from where its talk stands rather than from silence. Read off
 * the thread: a quiet group's ten can be a week back, and in a host
 * every conversation waits on the thread while the disk answers.
 */
async function saidLately(at: Local, group: string): Promise<string> {
	const ids = await at.transport.listAllIds();
	const latest: string[] = [];
	for (let index = ids.length - 1; index >= 0; index--) {
		if (latest.length >= LATELY) break;
		const message = await at.transport.readOff(ids[index] as string);
		if (!message?.to.includes(group)) continue;
		const whole = oneLine(line(message));
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

export async function leave(
	at: Local,
	params: { group: string },
): Promise<Answer> {
	const group = groupNamed(params.group);
	const left = group !== undefined && at.peer.leave(group);
	const scoped = group !== undefined && at.peer.scopes.includes(group);
	const said = scoped
		? `${left ? `Left what this peer joined of ${group}, but it` : group} is one of this peer's scopes: its work puts it there, so it hears ${group} until it works on something else.`
		: left
			? `Left ${group}.`
			: `Not in ${params.group}, so nothing changed.`;
	return answer(`${said} ${standsText(at.peer)} ${LISTED_IN_GROUPS}`, {
		groups: at.peer.groups,
	});
}

/**
 * Where a join or a leave points for every group and who is in it: a
 * busy mesh's whole listing runs to hundreds of kilobytes, which an
 * answer about one group has no need of (OSPHT4, 15 November).
 */
const LISTED_IN_GROUPS = "mesh_groups lists every group and who is in it.";

/** A group's members among the peers present, this peer included. */
function membersText(standing: Census, peer: Peer, group: string): string {
	const others = standing.present
		.filter((one) => one.session !== peer.session && one.groups.includes(group))
		.flatMap((one) => one.addresses.slice(0, 1));
	const own = peer.groups.includes(group) ? peer.addresses.slice(0, 1) : [];
	return `${group}: ${[...new Set([...others, ...own])].join(", ")}.`;
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

/** The groups this peer is in, by its work and by joining. */
function standsText(peer: Peer): string {
	const joined = peer.joined.filter((group) => !peer.scopes.includes(group));
	const standsIn = [
		peer.scopes.length > 0 ? `is in ${peer.scopes.join(", ")} by its work` : "",
		joined.length > 0 ? `has joined ${joined.join(", ")}` : "",
	].filter(Boolean);
	return standsIn.length > 0
		? `This peer ${standsIn.join(", and ")}; it is also in its home group and #machine.`
		: "This peer is in its home group and #machine only.";
}

/**
 * mesh_groups' own part: this peer, the groups and who is in each, and
 * the stops either way. The stops this peer is under are read from
 * `everyone`, the census before `listable`, since a stopper that names no
 * address is left out of the listing yet its stop still holds, and
 * `stopsText` names it only as a peer naming no address.
 */
export function groupsText(
	standing: Census,
	peer: Peer,
	everyone: readonly Presence[],
): string {
	// The census already reads a resuming past of a running session as
	// gone, so every member here is a session that is there or coming back.
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
	const own = standsText(peer);
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
	// Listed as the Ended line lists, of those in a group.
	const back = [
		...new Set(
			standing.resuming
				.filter((one) => one.groups.length > 0 && one.addresses[0])
				.map((one) => one.addresses[0] as string),
		),
	];
	const resuming =
		back.length > 0
			? `\nResuming, as their host starts again, still theirs: ${back.join(", ")}.`
			: "";
	const stopping =
		peer.stops.length > 0
			? `\nStopped by this peer: ${peer.stops.map((one) => one.address).join(", ")}.`
			: "";
	const stops = stoppedBy(peer, everyone);
	const stoppedHere = stops.length > 0 ? `\n${stopsText(stops)}` : "";
	const waiting = wantsText(standing.present);
	const more = `${gone}${resuming}${stopping}${stoppedHere}${waiting}`;
	return lines.length > 0
		? `${own}\nGroups:\n${lines.join("\n")}${more}`
		: `${own} No other groups yet.${more}`;
}

/** How much of what a peer works on mesh_groups says, to name it. */
const WORK_CHARS = 100;

/**
 * The census as mesh_groups lists it, each presence held to what its
 * lines may say. A presence says its strings as any it likes, and a
 * reader checks a grant against the quest a peer line names, so none
 * may carry a line of its own into the listing, nor a field of another
 * peer's into its own line. A presence whose signature isn't an address
 * is left out, as are its other addresses that aren't one, its groups
 * and joined groups that aren't one as `groupNamed` writes it (each opens
 * a line of the Groups section), a machine or tool step whose
 * name isn't shaped as a name, and a quest that isn't a quest id as
 * quest-workflow mints one; its prose, what it
 * works on, wants and a step's detail, is said on one line, as
 * `stopsText` says the reasons its stops give.
 */
export function listable(standing: Census): Census {
	const shown = (all: readonly Presence[]) => all.flatMap(listed);
	return {
		present: shown(standing.present),
		gone: shown(standing.gone),
		resuming: shown(standing.resuming),
	};
}

/** Whether a presence's group is one as it is written canonically. */
function isGroup(group: string): boolean {
	return groupNamed(group) === group;
}

/**
 * A want as mesh_groups may list it: its one line, without the whole of
 * what it asks, another session's paragraphs, which no listing prints.
 */
function listedWant(want: NonNullable<Presence["wants"]>): typeof want {
	const { asked: _whole, ...line } = want;
	return { ...line, said: oneLine(want.said) };
}

/** One presence as mesh_groups may list it, or none. */
function listed(one: Presence): Presence[] {
	const [signature, ...others] = one.addresses;
	if (signature === undefined || !isAddress(signature)) return [];
	const { quest, machine, stepDetail, wants, joined, ...rest } = one;
	const named = questNamed(quest);
	return [
		{
			...rest,
			addresses: [signature, ...others.filter(isAddress)],
			groups: one.groups.filter(isGroup),
			worksOn: oneLine(one.worksOn),
			...(joined !== undefined ? { joined: joined.filter(isGroup) } : {}),
			...(named !== undefined ? { quest: named } : {}),
			...(machine !== undefined && isName(machine) ? { machine } : {}),
			...(stepDetail !== undefined &&
			(stepDetail.kind !== "tool" || isName(stepDetail.name))
				? { stepDetail: { ...stepDetail, detail: oneLine(stepDetail.detail) } }
				: {}),
			...(wants !== undefined ? { wants: listedWant(wants) } : {}),
		},
	];
}

/**
 * A presence's quest, when it is a quest id as quest-workflow mints one:
 * a reader checks a grant against the quest a peer line names, so a
 * document's id or anything longer than an id is never named as one.
 */
function questNamed(quest: string | undefined): string | undefined {
	return quest !== undefined && isId(quest) && prefixOf(quest) === "QEST"
		? quest
		: undefined;
}

/** How long a step runs before mesh_groups says what it is. */
const STEP_SAID_AFTER_MS = 60_000;

/**
 * Every other peer still there, one line each: whether it is in a run,
 * and what it works on, so a peer can tell whom to ask without asking.
 * A quest is named only as `listable` would keep it, whoever calls; one
 * line each holds for presences as `listable` gives them.
 */
export function peersText(
	present: readonly Presence[],
	peer: Pick<Peer, "session">,
	now: number,
	resuming: readonly Presence[] = [],
): string {
	const back = new Set(resuming.map((one) => one.session));
	const lines = present.flatMap((one) => {
		const address = one.addresses[0];
		if (one.session === peer.session || !address) return [];
		const work = oneLine(one.worksOn);
		const cut =
			work.length > WORK_CHARS ? `${work.slice(0, WORK_CHARS - 3)}...` : work;
		const where = one.machine ? ` on ${one.machine}` : "";
		// Its own quest, apart from the groups it joined, which any peer
		// may: a grant comes from the peer whose own quest holds the work.
		const named = questNamed(one.quest);
		const quest = named !== undefined ? `, quest ${named}` : "";
		const run = back.has(one.session)
			? "resuming as its host starts again"
			: runText(one, now);
		return [`${address}${where}${quest}, ${run}: ${cut}`];
	});
	return lines.length > 0 ? `\nPeers:\n${lines.join("\n")}` : "";
}

/**
 * Whether a peer is in a run and, once a step has gone on a minute, what
 * the step is and for how long. A single tool call that runs for hours
 * otherwise reads as a run that is merely busy, or as a stuck model
 * request, since the session's file says nothing until the call ends.
 */
function runText(one: Presence, now: number): string {
	if (one.state === "parked") return "parked";
	if (!one.busy) return "idle";
	const step = one.stepDetail;
	const lasted = step ? now - Date.parse(step.since) : Number.NaN;
	if (!step || !(lasted >= STEP_SAID_AFTER_MS)) return "busy";
	const span = lastedText(lasted);
	if (step.kind === "tool") return `busy, in ${step.name} for ${span}`;
	if (step.kind === "thinking") return `busy, thinking for ${span}`;
	return `busy, waiting on its person for ${span}`;
}

/** The most ties mesh_groups lists, strongest first. */
const MOST_TIES = 12;

/** The longest a tied peer's work is quoted at. */
const TIE_WORK_CHARS = 60;

/**
 * The cells this peer is tied to, strongest first, as the node keeps
 * them from who has talked with whom in the last day (mycelium's `tie`
 * kind): each by its address and what it works on, with how strong the
 * tie is now and what each end said on it. Nothing when the node keeps
 * no ties, as one before mycelium #245, or none answers.
 */
export function tiesText(
	ties: readonly Tie[] | undefined,
	present: readonly Presence[],
): string {
	if (ties === undefined) return "";
	if (ties.length === 0) {
		return "\nTies: none in the last day. A message ties its sender to each peer its to names and to the one it answers; one only to groups ties no one.";
	}
	// A tie's other end is whatever its messages signed, and the node
	// relays its intents as it counted them, so a line opens only on an
	// address and names only intents shaped as one.
	const shown = ties.filter((tie) => isAddress(tie.other));
	const unshown = ties.length - shown.length;
	const left =
		unshown > 0
			? `${unshown} ${unshown === 1 ? "tie" : "ties"} left out, the other end not an address`
			: "";
	if (shown.length === 0) return `\nTies: ${left}.`;
	const lines = shown.slice(0, MOST_TIES).map((tie) => {
		const found = present.find((one) => one.addresses.includes(tie.other));
		const work = found !== undefined ? oneLine(found.worksOn) : undefined;
		const cut =
			work && work.length > TIE_WORK_CHARS
				? `${work.slice(0, TIE_WORK_CHARS - 3)}...`
				: work;
		const named = tie.intents.filter(isName);
		const intents = named.length > 0 ? `; ${named.join(", ")}` : "";
		return `${tie.other}${cut ? ` (${cut})` : ""}: ${tie.strength.toFixed(1)}; this hour ${tie.hour[0]} sent, ${tie.hour[1]} heard; today ${tie.today[0]} sent, ${tie.today[1]} heard${intents}`;
	});
	const more =
		shown.length > MOST_TIES ? [`and ${shown.length - MOST_TIES} weaker`] : [];
	const rest = left ? [`and ${left}`] : [];
	return `\nTies, strongest first (one a message, halving every two hours):\n${[...lines, ...more, ...rest].join("\n")}`;
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
