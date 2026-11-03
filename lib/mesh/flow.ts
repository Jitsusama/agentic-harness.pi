/**
 * Realm flows: the one-way roads a realm's node lets a message take into
 * another realm.
 *
 * Realms are kept apart, but Joel wanted some talk to cross, safely: "a
 * policy concept. nothing from zone x can go to zone y, but zone y can
 * go to zone x." So each node is told, in Nix, which realms its own may
 * send to, and it alone carries a crossing: a session asks it which
 * realms those are, and hands it the message to send. A crossing is text
 * only, to peers by address, and is never written into this realm's
 * mesh, so nothing here reads it and nothing there can answer it. A node
 * too old to know flows answers that it doesn't, which reads as none, so
 * a session on it sends only within its realm, as it always has.
 */

import { isRecord } from "../internal/record.ts";
import { askAt, NODE_PATIENCE_MS } from "./node.ts";

/**
 * How long a crossing has to answer: the node hands it to the other
 * realm's node on the same machine, or stores it for a link to carry,
 * both well inside a second, so this is spent only on one that hangs.
 */
export const CROSS_PATIENCE_MS = 5000;

/**
 * The realms the node serving `socket` lets this realm send to, none
 * when it names none, knows no flows, or doesn't answer within
 * `patience`.
 */
export async function flowsAt(
	socket: string | undefined,
	patience: number = NODE_PATIENCE_MS,
): Promise<readonly string[]> {
	const line = await askAt(socket, "Flows", patience);
	return line === undefined ? [] : flowsFrom(line);
}

/** The realms a node's answer to `"Flows"` names, or none. */
export function flowsFrom(line: string): readonly string[] {
	let reply: unknown;
	try {
		reply = JSON.parse(line);
	} catch {
		// Not an answer this reader knows, so no road is open.
		return [];
	}
	const flows = isRecord(reply) && isRecord(reply.Ok) ? reply.Ok.Flows : null;
	const to = isRecord(flows) ? flows.to : undefined;
	if (!Array.isArray(to)) return [];
	return to.filter((realm): realm is string => typeof realm === "string");
}

/** A message to send into another realm. */
export interface Crossing {
	/** The realm it goes to, one of the node's flows. */
	readonly realm: string;
	/** The address it is signed with. */
	readonly from: string;
	/** The groups it goes to, as the mesh writes them (`@4UHC5Q`). */
	readonly to: readonly string[];
	readonly intent: string;
	readonly text: string;
	/** The id of a message in that realm it answers. */
	readonly re?: string;
}

/** A crossing as the node sent it. */
export interface Crossed {
	readonly id: string;
	readonly at: string;
	readonly from: string;
	/** The groups it went to, as the mesh writes them. */
	readonly to: readonly string[];
	readonly intent: string;
	readonly text: string;
	/** The realm it was sent from, this one. */
	readonly fromRealm?: string;
}

/**
 * Why a node refused a crossing, as it says it: `no_flow`, `not_text`,
 * `unheard` or `unreached`, or another a newer node adds, carried as
 * said. `unanswered` is this harness's own, for a node that said nothing
 * this reader knows.
 */
export type CrossAnswer =
	| { readonly ok: true; readonly crossed: Crossed }
	| { readonly ok: false; readonly code: string; readonly why: string };

/**
 * Hands `crossing` to the node serving `socket` to send across, answering
 * the message as sent or why it wasn't.
 */
export async function crossAt(
	socket: string | undefined,
	crossing: Crossing,
	patience: number = CROSS_PATIENCE_MS,
): Promise<CrossAnswer> {
	const asked = {
		Send: {
			from: crossing.from,
			groups: crossing.to.map(nodeGroupOf),
			intent: crossing.intent,
			text: crossing.text,
			...(crossing.re !== undefined ? { re: crossing.re } : {}),
			realm: crossing.realm,
		},
	};
	const line = await askAt(socket, asked, patience);
	if (line === undefined) {
		return {
			ok: false,
			code: "unanswered",
			why: "no mycelium node answered this realm's socket",
		};
	}
	return crossedFrom(line);
}

/** A crossing's answer read: sent, or the node's refusal. */
export function crossedFrom(line: string): CrossAnswer {
	let reply: unknown;
	try {
		reply = JSON.parse(line);
	} catch {
		// Fall through to the answer this reader can't read.
	}
	const refused = isRecord(reply) ? reply.Refused : undefined;
	if (isRecord(refused)) {
		return {
			ok: false,
			code: typeof refused.code === "string" ? refused.code : "refused",
			why: typeof refused.why === "string" ? refused.why : "it gave no why",
		};
	}
	if (isRecord(reply) && typeof reply.Err === "string") {
		return { ok: false, code: "err", why: reply.Err };
	}
	const sent = isRecord(reply) && isRecord(reply.Ok) ? reply.Ok.Sent : null;
	if (
		isRecord(sent) &&
		typeof sent.id === "string" &&
		typeof sent.from === "string" &&
		typeof sent.text === "string"
	) {
		const groups = Array.isArray(sent.groups) ? sent.groups : [];
		return {
			ok: true,
			crossed: {
				id: sent.id,
				at: typeof sent.at === "string" ? sent.at : new Date().toISOString(),
				from: sent.from,
				to: groups
					.filter((group): group is string => typeof group === "string")
					.map(meshGroupOf),
				intent: typeof sent.intent === "string" ? sent.intent : "fyi",
				text: sent.text,
				...(typeof sent.fromRealm === "string"
					? { fromRealm: sent.fromRealm }
					: {}),
			},
		};
	}
	return {
		ok: false,
		code: "unanswered",
		why: `the node answered what this harness can't read: ${line.slice(0, 200)}`,
	};
}

/**
 * The node's name for a mesh group: a peer's `@4UHC5Q` is
 * `peer.4uhc5q`, and `#quest/4uhc5q` is `quest.4uhc5q`.
 */
export function nodeGroupOf(group: string): string {
	return group.startsWith("@")
		? `peer.${group.slice(1).toLowerCase()}`
		: group.replace(/^#/, "").replaceAll("/", ".").toLowerCase();
}

/** The mesh's name for a node group, the other way from {@link nodeGroupOf}. */
export function meshGroupOf(group: string): string {
	const address = group.startsWith("peer.") ? group.slice(5) : undefined;
	return address !== undefined && !address.includes(".")
		? `@${address.toUpperCase()}`
		: `#${group.replaceAll(".", "/")}`;
}
