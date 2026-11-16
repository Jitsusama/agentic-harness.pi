/**
 * What every mesh tool acts through: the session's place on the mesh,
 * the peers standing on it, and how a tool answers and tells a peer.
 */

import type { QueueRecord } from "../../../lib/internal/priority/folder.ts";
import type { TickedOwner } from "../../../lib/internal/process-ticks.ts";
import { answeringTo } from "../../../lib/mesh/address.ts";
import type { CrossAnswer, Crossing } from "../../../lib/mesh/flow.ts";
import { homeOf } from "../../../lib/mesh/group.ts";
import type { Board } from "../../../lib/mesh/lease.ts";
import { type Census, census } from "../../../lib/mesh/liveness.ts";
import { type Message, senderIdentity } from "../../../lib/mesh/message.ts";
import type { Peer } from "../../../lib/mesh/peer.ts";
import type { Presences } from "../../../lib/mesh/presence.ts";
import type { Judge } from "../../../lib/mesh/routing.ts";
import type { Transport } from "../../../lib/mesh/transport.ts";
import type { Waiting } from "../wait.ts";

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
	/** The realms the node lets this one send to (see lib/mesh/flow.ts). */
	readonly flows?: () => Promise<readonly string[]>;
	/** Hand a message to the node to send into another realm. */
	readonly cross?: (crossing: Crossing) => Promise<CrossAnswer>;
	/** Note a message this peer sent, so it is never handed back to it. */
	sent(message: Message): void;
	/**
	 * Ask the person to confirm ending another peer's hold on their word:
	 * why it may not be sent, or nothing once it may (see end-hold.ts).
	 */
	confirmEnd?(hold: Message, text: string): Promise<string | undefined>;
	/** Where what waits on the person is kept (see wait.ts). */
	readonly waiting?: Waiting;
	/** Where what sessions point the person at is kept (lib/mesh/looks.ts). */
	readonly looks?: string;
	/** Ask a session's process to end; pi's own SIGTERM by default. */
	readonly endProcess?: EndProcess;
	/** Ask a parked session's holder to wake it; whether it was parked. */
	readonly wakeParked?: (session: string, why: string) => boolean;
}

/**
 * Asks the process a presence names to end, once it is sure it is that
 * one, saying `by` asked, for a host's journal.
 */
export type EndProcess = (
	owner: TickedOwner,
	by: string,
) => Promise<"ended" | "gone" | "unsure">;

export type Answer = ReturnType<typeof answer>;

/**
 * Every peer, answering only to its own addresses, sorted by whether
 * it is still on the mesh.
 */
export function peers(at: Local): Promise<Census> {
	const everyone = at.presences.all();
	return census(
		everyone.map((one) => ({
			...one,
			addresses: answeringTo(one, everyone),
		})),
	);
}

/** Say something to one peer's home group, as the mesh itself would. */
export function tell(at: Local, address: string, text: string): void {
	const message = at.transport.send({
		from: at.peer.signature,
		to: [homeOf(address)],
		intent: "fyi",
		text,
		...senderIdentity(),
	});
	at.sent(message);
}

export function answer(text: string, details: unknown = {}) {
	return { content: [{ type: "text" as const, text }], details };
}
