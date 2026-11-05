/**
 * Who may end whom.
 *
 * Joel, 4 November: "make sure we are closing any pi processes and/or
 * kitty windows that are no longer needed". A session ends itself once
 * its quest has ended (quest-workflow's ends-with-quest.ts); this is
 * for the rest, a session its orchestrator knows is done with, as the
 * 19 it ended by hand that day. Like a pivot, ending keeps its
 * authority only on the way down: the session playing an
 * orchestrator's role ends a session whose quest it orchestrates, on
 * this machine, and nobody else ends one at all. The process is the one
 * the session's presence names, judged by its start, so a pid the
 * kernel has since handed to something else is never signalled.
 */

import type { TickedOwner } from "../internal/process-ticks.ts";
import type { Presence } from "./presence.ts";

/** The session to end and the process holding it, or why it may not be. */
export type EndTarget =
	| {
			readonly address: string;
			readonly session: string;
			readonly owner: TickedOwner;
	  }
	| { readonly refused: string };

/**
 * The session the orchestrator heading `orchestrates`, running as
 * `self`, may end by `address`, among those `present`.
 */
export function endTarget(
	orchestrates: string | undefined,
	self: string,
	address: string,
	present: readonly Pick<
		Presence,
		"addresses" | "session" | "orchestratedBy" | "owner" | "machine"
	>[],
): EndTarget {
	if (orchestrates === undefined) {
		return {
			refused:
				"only an orchestrator ends a session, and this session plays no orchestrator's role. A session ends itself once its quest is concluded or retired",
		};
	}
	const one = present.find((each) => each.addresses.includes(address));
	if (!one) {
		return {
			refused: `no session on the mesh goes by ${address}; mesh_groups lists who does`,
		};
	}
	if (one.session === self) {
		return {
			refused:
				"that is this session; conclude its quest and it ends itself once nothing is left in it",
		};
	}
	if (one.orchestratedBy !== orchestrates) {
		return {
			refused: `${address} is not in this orchestration, ${orchestrates}, so it is its own orchestrator's to end`,
		};
	}
	if (one.machine !== undefined) {
		return {
			refused: `${address} runs on ${one.machine}, and only its own machine can judge and end its process`,
		};
	}
	if (!one.owner) {
		return {
			refused: `${address}'s presence names no process, so there is nothing here to end`,
		};
	}
	return { address, session: one.session, owner: one.owner };
}
