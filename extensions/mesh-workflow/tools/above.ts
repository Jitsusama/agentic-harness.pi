/**
 * Who `orchestrator` reaches for this peer: its quest's orchestrator
 * when the mark names one, else its hub from use
 * (lib/mesh/hub-from-use.ts). Read only when a send names the word,
 * since finding the hub asks the node for this peer's ties.
 */

import { type Above, hubFromUse } from "../../../lib/mesh/hub-from-use.ts";
import { type Local, peers } from "./local.ts";

/** Where this peer's `orchestrator` points, or why nowhere. */
export async function aboveFor(at: Local): Promise<Above> {
	const mark = at.peer.orchestratedBy;
	if (mark !== undefined) return { address: mark, by: "mark" };
	const [standing, ties] = await Promise.all([
		peers(at),
		at.ties ? at.ties() : Promise.resolve(undefined),
	]);
	const self = at.presences
		.all()
		.find((one) => one.session === at.peer.session);
	if (self === undefined) {
		return {
			none: "this peer has no presence on the mesh yet, so no orchestrator or hub from use is above it",
		};
	}
	return hubFromUse(self, standing.present, ties);
}
