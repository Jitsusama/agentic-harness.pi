/**
 * What the mesh tools see of this peer: its transport, leases and groups,
 * and what follows a message it sends.
 */

import { askWake, isParked } from "../../../lib/internal/session/park.ts";
import { cross } from "../../../lib/mesh/crossing.ts";
import { crossAt } from "../../../lib/mesh/flow.ts";
import { isCurrent, ownerOf } from "../../../lib/mesh/lease.ts";
import { needAt } from "../../../lib/mesh/need-route.ts";
import { nodeSocket, servedAt, tiesAt } from "../../../lib/mesh/node.ts";
import { wakeParked } from "../../../lib/mesh/parked.ts";
import {
	liveProbes,
	PROBE_WITHIN_MS,
} from "../../../lib/orchestration/done-acts.ts";
import { slackOfThePerson } from "../../../lib/orchestration/done-acts-slack.ts";
import { untestedCausesFound } from "../../../lib/prose/claims.ts";
import { UNJUDGED } from "../delivery.ts";
import { confirmEnd } from "../end-hold.ts";
import { queueJobs } from "../leases.ts";
import { type Local, registerTools } from "../tools.ts";
import type { Hearing } from "./hearing.ts";
import type { MeshState } from "./mesh.ts";
import type { Waits } from "./waits.ts";

/** Register the mesh tools over this peer. */
export function registerLocal(m: MeshState, f: Waits & Hearing) {
	/**
	 * Why the claim check judged nothing, each kind said once a session in
	 * the log, with the first line of what went wrong. Counted only once
	 * written, so a log that refused one line says it at the next send.
	 */
	const unjudged = (why: string, detail?: string) => {
		if (m.unjudgedSaid.has(why)) return;
		try {
			m.pi.appendEntry(
				UNJUDGED,
				detail === undefined ? { why } : { why, detail },
			);
			m.unjudgedSaid.add(why);
		} catch {
			// A log that won't take the line costs it here; the send is judged
			// as far as it was, and the next one tries the line again.
		}
	};
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
					keptHub: (gone) => m.hub?.current(gone),
					nodeAnswered: () => m.hub?.nodeAnswered(),
					need: (asked, live, stopped) =>
						needAt(nodeSocket(m.env), asked, {
							live,
							stopped,
							keep: m.paths.mesh,
						}),
					served: (ids) => servedAt(nodeSocket(m.env), ids),
					asWrittenOff: m.asWrittenOff,
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
					untested: async (text) => {
						try {
							return await untestedCausesFound(
								text,
								m.classifier,
								unjudged,
								// Judged in full by a classifier that answered: a reason
								// that comes back is news again. A send nothing judged, as
								// with the classifier off or no part long enough, clears
								// nothing, nor does one judged only in part.
								() => m.unjudgedSaid.clear(),
							);
						} catch {
							// With no classifier to be had, nothing is judged and the
							// message goes as written.
							return [];
						}
					},
					...(m.env.MYCELIUM_HELD ? { holder: m.env.MYCELIUM_HELD } : {}),
					...(m.workerLink ? { endHeld: m.workerLink.end } : {}),
					...(m.paths.looks ? { looks: m.paths.looks } : {}),
					...(m.waiting ? { waiting: m.waiting } : {}),
				}
			: undefined;
	registerTools(
		m.pi,
		local,
		() => m.quiet,
		() => m.paths.looks,
	);
}
