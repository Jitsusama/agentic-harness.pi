/**
 * The mesh's tools: send, read back, and join, leave or list groups.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { answeringTo } from "../../lib/mesh/address.ts";
import {
	ALL,
	groupNamed,
	groupsNamed,
	hears,
	homeOf,
	isJoinable,
} from "../../lib/mesh/group.ts";
import { type Census, census } from "../../lib/mesh/liveness.ts";
import {
	INTENTS,
	line,
	type Message,
	reaches,
} from "../../lib/mesh/message.ts";
import type { Peer } from "../../lib/mesh/peer.ts";
import type { Presence, Presences } from "../../lib/mesh/presence.ts";
import type { Transport } from "../../lib/mesh/transport.ts";

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
	/** Note a message this peer sent, so it is never handed back to it. */
	sent(message: Message): void;
}

/** What mesh_send hands back beside its words. */
export interface SendDetails {
	readonly sent: boolean;
	/** What it refused, when it sent nothing. */
	readonly refused?: readonly string[];
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
					"This pi is not on the mesh: it keeps no session, or has not started one yet.",
				);
			}
			at.peer.refresh();
			return act(at, params);
		};

	pi.registerTool({
		name: "mesh_send",
		label: "Mesh",
		description:
			"Send a message to other pi sessions (peers) on this machine without interrupting them: it joins their conversation as context, at the attention each gives it. Send only what changes what another peer should do (a hold before a reboot, a switch, a merge or a heavy build; a question only it can answer) or what concerns something it owns (a finding). Never send progress, acknowledgements or thanks. Every message goes to a group: a peer's home group by its address (5GV2AH), a group by name (#harness), or #all, which is only for what touches every peer on the machine. Pick the narrowest that reaches everyone affected; mesh_groups lists the groups and who is in them.",
		parameters: Type.Object({
			to: Type.String({
				description:
					"Comma-separated groups: peer addresses such as P9R1KI, groups such as #harness, or all",
			}),
			intent: StringEnum(INTENTS, {
				description:
					"hold: put off something until you say it is over; question: wants an answer; finding: for whoever owns what it is about; fyi: context only",
			}),
			text: Type.String({
				description: "The message, plain and short, standing on its own",
			}),
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
			"Join a mesh group, so this peer hears what is sent to it and to the groups it is part of. Join the groups for the work this peer does (#harness, #optimus/power), not every group there is; join a peer's address to follow its home group.",
		parameters: Type.Object({
			group: Type.String({
				description:
					"A group such as #harness, a part of one such as #optimus/power, or a peer's address",
			}),
		}),
		execute: using(join),
	});

	pi.registerTool({
		name: "mesh_leave",
		label: "Mesh",
		description:
			"Leave a mesh group this peer no longer works on, so its messages stop reaching it.",
		parameters: Type.Object({
			group: Type.String({ description: "The group to leave" }),
		}),
		execute: using(leave),
	});

	pi.registerTool({
		name: "mesh_groups",
		label: "Mesh",
		description:
			"List the mesh groups, who is in each, and which this peer is in.",
		parameters: Type.Object({}),
		execute: using(async (at) =>
			answer(groupsText(await peers(at), at.peer), {
				groups: at.peer.groups,
			}),
		),
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

async function send(
	at: Local,
	params: { to: string; intent: Message["intent"]; text: string },
): Promise<Answer> {
	const to = groupsNamed(params.to);
	const standing = await peers(at);
	const everyone = standing.present;
	const refused = to.filter(
		// Only peers still there count as in a group: a group whose every
		// other member has ended is one nobody would hear this in.
		(group) =>
			groupNamed(group) === undefined ||
			(group.startsWith("#") &&
				group !== ALL &&
				!anyoneElseIn(group, everyone, at.peer)),
	);
	if (refused.length > 0) {
		return answer(
			`Not sent: nobody else is in ${refused.join(", ")}. ${groupsText(standing, at.peer)}`,
			{ sent: false, refused } satisfies SendDetails,
		);
	}
	const message = at.transport.send({
		from: at.peer.signature,
		to,
		intent: params.intent,
		text: params.text,
		pid: process.pid,
	});
	at.sent(message);
	const reached = everyone
		.filter(
			(one) => one.session !== at.peer.session && one.addresses.length > 0,
		)
		.filter((one) => reaches(message, one, -1))
		.map((one) => one.addresses[0] as string);
	const homes = (list: readonly Presence[]) =>
		new Set(list.flatMap((one) => one.addresses.map(homeOf)));
	const there = homes(everyone);
	const ended = homes(standing.gone);
	const addressed = to.filter((group) => group.startsWith("@"));
	const gone = addressed
		.filter((group) => !there.has(group) && ended.has(group))
		.map((group) => group.slice(1));
	const unknown = addressed
		.filter((group) => !there.has(group) && !ended.has(group))
		.map((group) => group.slice(1));
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
	].filter(Boolean);
	return answer(
		`Sent as ${message.from}: ${line(message)}\n${notes.join(" ")}`,
		{ sent: true, message, reached, gone } satisfies SendDetails,
	);
}

async function read(at: Local, params: { count?: number }): Promise<Answer> {
	const wanted = Math.min(
		MOST_READ,
		Math.max(1, Math.floor(params.count ?? 15)),
	);
	const latest = at.transport
		.ids()
		.map((id) => at.transport.read(id))
		.filter((message): message is Message => message !== undefined)
		.filter(
			(message) =>
				message.pid === process.pid ||
				at.peer.addresses.includes(message.from) ||
				reaches(message, at.peer.listener, -1),
		)
		.slice(-wanted);
	const receipt = receipts(at, (await peers(at)).present);
	const text =
		latest.length > 0
			? latest
					.map((message) =>
						[line(message), receipt(message)].filter(Boolean).join("\n  "),
					)
					.join("\n")
			: "Nothing on the mesh yet.";
	return answer(`This peer is ${at.peer.addresses.join(" or ")}.\n${text}`);
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

async function join(at: Local, params: { group: string }): Promise<Answer> {
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
	at.peer.join(group);
	return answer(`In ${group}. ${groupsText(await peers(at), at.peer)}`, {
		groups: at.peer.groups,
	});
}

async function leave(at: Local, params: { group: string }): Promise<Answer> {
	const group = groupNamed(params.group);
	const left = group !== undefined && at.peer.leave(group);
	const everyone = await peers(at);
	return answer(
		left
			? `Left ${group}. ${groupsText(everyone, at.peer)}`
			: `Not in ${params.group}, so nothing changed. ${groupsText(everyone, at.peer)}`,
		{ groups: at.peer.groups },
	);
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
	const own =
		peer.groups.length > 0
			? `This peer is in ${peer.groups.join(", ")}, its home group and #all.`
			: "This peer is in its home group and #all only.";
	const ended = standing.gone
		.filter((one) => one.groups.length > 0 && one.addresses[0])
		.map((one) => one.addresses[0]);
	const gone =
		ended.length > 0
			? `\nEnded, so left out until restored: ${ended.join(", ")}.`
			: "";
	return lines.length > 0
		? `${own}\nGroups:\n${lines.join("\n")}${gone}`
		: `${own} No other groups yet.${gone}`;
}

function answer(text: string, details: unknown = {}) {
	return { content: [{ type: "text" as const, text }], details };
}
