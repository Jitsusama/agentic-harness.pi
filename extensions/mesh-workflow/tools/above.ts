/**
 * Who `orchestrator` reaches for this peer: its quest's orchestrator
 * when the mark names one, else its hub from use
 * (lib/mesh/hub-from-use.ts). Read only when a send names the word,
 * since finding the hub asks the node for this peer's ties.
 */

import { type Above, hubFromUse } from "../../../lib/mesh/hub-from-use.ts";
import { type Local, peers } from "./local.ts";

/** What finding the hub reads of this peer. */
export type HubReading = Pick<Local, "peer" | "presences" | "ties">;

/** Where this peer's `orchestrator` points, or why nowhere. */
export async function aboveFor(at: HubReading): Promise<Above> {
	const mark = at.peer.orchestratedBy;
	if (mark !== undefined) return { address: mark, by: "mark" };
	// A quest that heads an orchestration carries the mark itself, so it
	// has an orchestrator, its head: a hub above it would be a second
	// voice over the work it leads, for the head and for any other
	// session on the quest alike.
	if (at.peer.orchestrates !== undefined) {
		return {
			none: "this peer heads its own orchestration, so nothing is above it for `orchestrator` to reach",
		};
	}
	if (at.peer.questHeads !== undefined) {
		return {
			none: `this peer's quest heads its own orchestration, whose head is ${at.peer.questHeads}, so nothing is above it for \`orchestrator\` to reach; write to ${at.peer.questHeads} by its address`,
		};
	}
	const [standing, ties] = await Promise.all([
		peers(at),
		at.ties ? at.ties() : Promise.resolve(undefined),
	]);
	const self = standing.present.find((one) => one.session === at.peer.session);
	if (self === undefined) {
		return {
			none: "this peer has no presence on the mesh yet, so no orchestrator or hub from use is above it",
		};
	}
	return hubFromUse(self, standing.present, ties, standing.gone);
}
