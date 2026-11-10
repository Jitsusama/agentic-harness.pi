/**
 * What of this peer's own on the mesh will wake it, for a session
 * asking before it rests blocked (lib/internal/session/wakers.ts): a
 * hold it waits on, whose end gives it a turn; a question it asked
 * that a peer has yet to answer, whose answer does; and a Needs You
 * item it filed that the person has yet to settle.
 */

import { isCurrent, type Lease } from "../../lib/mesh/lease.ts";
import type { Message } from "../../lib/mesh/message.ts";
import { unanswered } from "../../lib/mesh/unanswered.ts";
import type { WaitingItem } from "../../lib/mesh/waiting.ts";

/** What the mesh knows of one peer, for saying what will wake it. */
export interface Own {
	/** The session asking. */
	readonly session: string;
	/** Every address it goes by. */
	readonly addresses: readonly string[];
	/** Its leases. */
	readonly leases: readonly Lease[];
	/** The mesh's recent messages, for its questions still open. */
	readonly messages: readonly Message[];
	/** Every address a peer goes by, from any one of them. */
	aliases(address: string): readonly string[];
	/** Its quest's Needs You items. */
	readonly items: readonly WaitingItem[];
}

/** What of this peer's own will wake it, each in a phrase. */
export function meshWakers(own: Own, now: number = Date.now()): string[] {
	const holds = own.leases.filter(
		(lease) => lease.kind === "wait" && isCurrent(lease, now),
	);
	const mine = new Set(own.addresses);
	const questions = unanswered(own.messages, own.aliases, now).filter(
		({ message, waitingOn }) => mine.has(message.from) && waitingOn.length > 0,
	);
	const items = own.items.filter((item) => item.owner?.session === own.session);
	return [
		...holds.map((hold) => `a hold it waits on [${hold.subject}]`),
		...questions.map(
			({ message, waitingOn }) =>
				`a question [${message.id}] awaiting ${waitingOn.join(", ")}`,
		),
		...items.map((item) => `a Needs You item, ${item.id}, not yet settled`),
	];
}
