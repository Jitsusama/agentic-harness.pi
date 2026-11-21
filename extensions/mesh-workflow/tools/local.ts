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
import type { NeedAsked, NeedRecord } from "../../../lib/mesh/need-route.ts";
import type { Tie } from "../../../lib/mesh/node.ts";
import type { Peer } from "../../../lib/mesh/peer.ts";
import type { Presences } from "../../../lib/mesh/presence.ts";
import type { Served } from "../../../lib/mesh/receptor.ts";
import type { Judge } from "../../../lib/mesh/routing.ts";
import type { Transport } from "../../../lib/mesh/transport.ts";
import type { DoneProbes } from "../../../lib/orchestration/done-acts.ts";
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
	/** This peer's ties, strongest first, as the node keeps them (lib/mesh/node.ts). */
	readonly ties?: () => Promise<readonly Tie[] | undefined>;
	/**
	 * Find the live cell that works on a need, over the node's hubs and
	 * ties, and keep where it went (lib/mesh/need-route.ts); nothing when
	 * no node answers. `live` names every present cell, those that stopped
	 * this peer among them, since a need goes to its fit alone and may be
	 * found through one. `stopped` is always said, as it alone keeps such a
	 * cell from being taken or named as ended.
	 */
	readonly need?: (
		asked: NeedAsked,
		live: (address: string) => boolean,
		stopped: (address: string) => boolean,
	) => Promise<NeedRecord | undefined>;
	/**
	 * Which messages the node serves, which vouches for one under a
	 * receptor's name (lib/mesh/receptor.ts). Without it, none is vouched.
	 */
	readonly served?: Served;
	/**
	 * One message as it lies, a receptor's name and all, for a reader that
	 * vouches for what it shows, read off the thread. Without it,
	 * `transport` reads it.
	 */
	readonly asWrittenOff?: (id: string) => Promise<Message | undefined>;
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
	/** Where what sessions point the person at is kept (lib/mesh/looks/looks.ts). */
	readonly looks?: string;
	/** Ask a session's process to end; pi's own SIGTERM by default. */
	readonly endProcess?: EndProcess;
	/** Ask a parked session's holder to wake it; whether it was parked. */
	readonly wakeParked?: (session: string, why: string) => boolean;
	/**
	 * The records that say whether an act of the person's hands is done
	 * (lib/orchestration/done-acts.ts); none, and nothing is judged.
	 */
	readonly doneProbes?: DoneProbes;
	/**
	 * The parts of a text the classifier judges to state an untested cause
	 * as settled (lib/prose/claims.ts); none, and nothing is judged.
	 */
	readonly untested?: (text: string) => Promise<readonly string[]>;
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
