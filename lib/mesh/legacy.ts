/**
 * The legacy mailbox, kept at the mesh's edge until no peer speaks it.
 *
 * Before the mesh, sessions sent "mail" through a folder of their own
 * (`~/.local/state/pi-mailbox`), addressed to session names, channels
 * and ALL, with a kind and channel memberships beside it. A session
 * keeps running the harness it started with until it reloads, so for a
 * while some peers speak only that. This is the anti-corruption layer
 * between them: the rest of the mesh sees one transport and one set of
 * presences, and only this module knows the old shapes.
 *
 * - Every mesh message is also written to the old folder in the old
 *   shape, under the same id, so legacy sessions hear it, and a mesh
 *   peer reading both folders sees it once.
 * - Old mail is read as mesh messages.
 * - A peer's presence is also kept as an old membership, so legacy
 *   senders see it on its groups, and legacy memberships count as
 *   peers, so mesh senders reach them.
 * - How far a peer had read the old folder carries over, so nothing is
 *   handed over twice when a session first reloads onto the mesh.
 *
 * Delete this module once no legacy membership has moved for a day.
 */

import { mkdirSync, readdirSync, readFileSync, watch } from "node:fs";
import { join } from "node:path";
import { ALL, isJoinable } from "./group.ts";
import { ENVELOPE, intentOf, type Message } from "./message.ts";
import type { Presence, Presences } from "./presence.ts";
import {
	idOf,
	isMessageFile,
	type Transport,
	writeAtomically,
} from "./transport.ts";

/** The customType old sessions recorded a passed-by message under. */
export const LEGACY_GLANCE = "mailbox-passed";

/** A transport that also carries the legacy mailbox in this folder. */
export function bridgeTransport(mesh: Transport, dir: string): Transport {
	return {
		send(draft) {
			const message = mesh.send(draft);
			try {
				writeAtomically(dir, `${message.id}.json`, legacyText(message));
			} catch {
				// Unmirrored, it still reaches every peer on the mesh.
			}
			return message;
		},
		ids: () => [...new Set([...mesh.ids(), ...legacyIds(dir)])].sort(),
		read: (id) => mesh.read(id) ?? readLegacy(dir, id),
		lastRead(addresses) {
			const legacy = addresses
				.map((address) => readText(join(dir, `.read-${address}`)))
				.filter((file): file is string => file !== undefined)
				.map(idOf);
			const own = mesh.lastRead(addresses);
			return [...legacy, ...(own ? [own] : [])].sort().pop();
		},
		markRead: (address, id) => mesh.markRead(address, id),
		watch(arrived) {
			const closeMesh = mesh.watch(arrived);
			try {
				mkdirSync(dir, { recursive: true });
				const watcher = watch(dir, (_kind, file) => {
					if (file && isMessageFile(file)) arrived(idOf(file));
				});
				return () => {
					closeMesh();
					watcher.close();
				};
			} catch {
				// Deaf to legacy peers only; the mesh itself is still heard.
				return closeMesh;
			}
		},
	};
}

/** Presences that also count, and keep, legacy memberships here. */
export function bridgePresences(mesh: Presences, dir: string): Presences {
	const members = join(dir, ".members");
	return {
		of: (session) => mesh.of(session) ?? legacyMember(members, session),
		publish(presence) {
			mesh.publish(presence);
			try {
				writeAtomically(
					members,
					`${fileSafe(presence.session)}.json`,
					JSON.stringify(membershipOf(presence)),
				);
			} catch {
				// Legacy senders cannot see this peer's groups; it still hears.
			}
		},
		all() {
			const current = mesh.all();
			const known = new Set(current.map((one) => one.session));
			const legacy = legacyMembers(members).filter(
				(one) => !known.has(one.session),
			);
			return [...current, ...legacy];
		},
	};
}

/** A glance an old session recorded, as the message it was about. */
export function legacyGlance(data: unknown): Message | undefined {
	const mail = (data as { mail?: unknown } | null)?.mail;
	return mail ? fromMail(mail, "") : undefined;
}

function legacyText(message: Message): string {
	return JSON.stringify({
		at: message.at,
		from: message.from,
		to: message.to.map(legacyRecipient),
		text: message.text,
		kind: message.intent,
		pid: message.pid,
		mesh: message.id,
	});
}

/** A canonical group as the legacy mailbox addressed it. */
function legacyRecipient(group: string): string {
	if (group === ALL) return "ALL";
	return group.startsWith("@") ? group.slice(1) : group;
}

/** A legacy recipient as a canonical group. */
function groupOf(recipient: string): string {
	if (recipient === "ALL") return ALL;
	return recipient.startsWith("#") ? recipient : `@${recipient}`;
}

function legacyIds(dir: string): string[] {
	try {
		return readdirSync(dir).filter(isMessageFile).map(idOf);
	} catch {
		return [];
	}
}

function readLegacy(dir: string, id: string): Message | undefined {
	const text = readText(join(dir, `${id}.json`));
	if (text === undefined) return undefined;
	try {
		return fromMail(JSON.parse(text), id);
	} catch {
		return undefined;
	}
}

/** Old mail as a mesh message, or nothing when it will not read. */
function fromMail(value: unknown, id: string): Message | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const mail = value as Record<string, unknown>;
	const valid =
		typeof mail.at === "string" &&
		typeof mail.from === "string" &&
		Array.isArray(mail.to) &&
		mail.to.every((to) => typeof to === "string") &&
		typeof mail.text === "string" &&
		typeof mail.pid === "number";
	if (!valid) return undefined;
	return {
		v: ENVELOPE,
		id,
		at: mail.at as string,
		from: mail.from as string,
		to: (mail.to as string[]).map(groupOf),
		intent: intentOf(mail.kind),
		text: mail.text as string,
		pid: mail.pid as number,
	};
}

function membershipOf(presence: Presence) {
	return {
		session: presence.session,
		names: presence.addresses,
		channels: presence.groups
			.filter((group) => isJoinable(group) && group.startsWith("#"))
			.map((group) => group.slice(1)),
	};
}

function legacyMember(dir: string, session: string): Presence | undefined {
	const text = readText(join(dir, `${fileSafe(session)}.json`));
	return text === undefined ? undefined : presenceOfMember(text);
}

function legacyMembers(dir: string): Presence[] {
	let files: string[] = [];
	try {
		files = readdirSync(dir).filter((file) => file.endsWith(".json"));
	} catch {
		return [];
	}
	return files
		.map((file) => readText(join(dir, file)))
		.filter((text): text is string => text !== undefined)
		.map(presenceOfMember)
		.filter((one): one is Presence => one !== undefined);
}

/** An old membership as a presence: its channels become groups. */
function presenceOfMember(text: string): Presence | undefined {
	try {
		const one = JSON.parse(text) as Record<string, unknown>;
		const strings = (list: unknown): list is string[] =>
			Array.isArray(list) && list.every((item) => typeof item === "string");
		if (
			typeof one.session !== "string" ||
			!strings(one.names) ||
			!strings(one.channels)
		) {
			return undefined;
		}
		return {
			session: one.session,
			addresses: one.names,
			groups: one.channels.map((channel) => `#${channel}`),
			worksOn: "",
			owns: [],
			// An old membership never said, and has no process to ask.
			busy: false,
			at: "",
		};
	} catch {
		return undefined;
	}
}

function fileSafe(session: string): string {
	return session.replace(/[^A-Za-z0-9-]/g, "_");
}

function readText(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8").trim() || undefined;
	} catch {
		return undefined;
	}
}
