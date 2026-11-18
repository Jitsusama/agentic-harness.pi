/**
 * What the mesh tools see of this peer: its transport, leases and groups,
 * and what follows a message it sends.
 */

import { askWake, isParked } from "../../../lib/internal/session/park.ts";
import { cross } from "../../../lib/mesh/crossing.ts";
import { crossAt } from "../../../lib/mesh/flow.ts";
import { isCurrent, ownerOf } from "../../../lib/mesh/lease.ts";
import { nodeSocket, tiesAt } from "../../../lib/mesh/node.ts";
import { wakeParked } from "../../../lib/mesh/parked.ts";
import {
	liveProbes,
	PROBE_WITHIN_MS,
} from "../../../lib/orchestration/done-acts.ts";
import { slackOfThePerson } from "../../../lib/orchestration/done-acts-slack.ts";
import { confirmEnd } from "../end-hold.ts";
import { queueJobs } from "../leases.ts";
import { type Local, registerTools } from "../tools.ts";
import type { Hearing } from "./hearing.ts";
import type { MeshState } from "./mesh.ts";
import type { Waits } from "./waits.ts";

/** Register the mesh tools over this peer. */
export function registerLocal(m: MeshState, f: Waits & Hearing) {
	/** Who waits on a hold, by the address each signs with. */
	const waitingOn = (id: string): string[] => {
		const now = Date.now();
		return m.board
			.all()
			.filter((holding) =>
				holding.leases.some(
					(lease) =>
						lease.kind === "wait" &&
						lease.subject === id &&
						isCurrent(lease, now),
				),
			)
			.flatMap((holding) => {
				const address = m.presences.of(ownerOf(holding))?.addresses[0];
				return address ? [address] : [];
			});
	};

	const local = (): Local | undefined =>
		m.peer
			? {
					peer: m.peer,
					transport: m.transport,
					presences: m.presences,
					board: m.board,
					route: f.routing,
					queue: () => queueJobs(m.env),
					flows: () => m.flows,
					cross: (crossing) => crossAt(nodeSocket(m.env), crossing),
					ties: () => tiesAt(nodeSocket(m.env), m.peer?.addresses ?? []),
					sent: (message) => {
						m.seen.add(message.id);
						if (message.re !== undefined) m.owing.paid(message.re);
						m.awaiting.asked(message, m.peer?.addresses ?? []);
						m.leasing.sent(message);
						f.watchWaits();
						// A parked peer it gives a turn is started again to take it.
						wakeParked(
							message,
							m.presences.all(),
							(id) => m.transport.read(id),
							(session) => isParked(session),
							(session, id) => {
								askWake(session, id);
							},
						);
						// A machine hold reaches the machine's other realms too.
						try {
							cross(message, m.crossings, (id) => m.transport.read(id));
						} catch {
							// Sent here already; another realm's mesh that can't be
							// written to misses this one hold, and its holds lapse.
						}
					},
					confirmEnd: (hold, text) =>
						confirmEnd(m.ctx, hold, text, waitingOn(hold.id)),
					doneProbes: liveProbes(
						(command, args) =>
							m.pi.exec(command, args, { timeout: PROBE_WITHIN_MS }),
						slackOfThePerson,
					),
					...(m.paths.looks ? { looks: m.paths.looks } : {}),
					...(m.waiting ? { waiting: m.waiting } : {}),
				}
			: undefined;
	registerTools(m.pi, local, () => m.quiet);
}
