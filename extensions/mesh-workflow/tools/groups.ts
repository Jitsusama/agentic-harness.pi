/**
 * mesh_join, mesh_leave and mesh_groups: the groups a peer is in, who
 * else is, and what each peer is doing.
 */

import {
	groupNamed,
	groupsNamed,
	hears,
	homeOf,
	isJoinable,
} from "../../../lib/mesh/group.ts";
import type { Census } from "../../../lib/mesh/liveness.ts";
import { clock, line, senderIdentity } from "../../../lib/mesh/message.ts";
import type { Peer } from "../../../lib/mesh/peer.ts";
import type { Presence } from "../../../lib/mesh/presence.ts";
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
			`${params.group} is not a group to join: name one with letters, digits and dashes after a #, with / between a group and its part, as #optimus/power, or give a peer's address. Every peer is in #machine already.`,
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

export async function leave(at: Local, params: { group: string }): Promise<Answer> {
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

export function groupsText(standing: Census, peer: Peer): string {
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

/** How long a step runs before mesh_groups says what it is. */
const STEP_SAID_AFTER_MS = 60_000;

/**
 * Every other peer still there, one line each: whether it is in a run,
 * and what it works on, so a peer can tell whom to ask without asking.
 */
export function peersText(
	present: readonly Presence[],
	peer: Peer,
	now: number,
): string {
	const lines = present.flatMap((one) => {
		const address = one.addresses[0];
		if (one.session === peer.session || !address) return [];
		const work = one.worksOn.replace(/\s+/g, " ").trim();
		const cut =
			work.length > WORK_CHARS ? `${work.slice(0, WORK_CHARS - 3)}...` : work;
		const where = one.machine ? ` on ${one.machine}` : "";
		return [`${address}${where}, ${runText(one, now)}: ${cut}`];
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
