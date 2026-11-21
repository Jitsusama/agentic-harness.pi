/** mesh_end: ending a session of this orchestration, and its process. */

import { endSession } from "../../../lib/core/session/index.ts";
import {
	type TickedOwner,
	tickedStanding,
} from "../../../lib/internal/process-ticks.ts";
import { askWake } from "../../../lib/internal/session/park.ts";
import { endTarget } from "../../../lib/mesh/end.ts";
import { groupNamed } from "../../../lib/mesh/group.ts";
import { closeThroughHost, hostedHere } from "../../../lib/mesh/host-close.ts";
import { heldOnce } from "../../../lib/mesh/liveness.ts";
import { type Answer, answer, type EndProcess, type Local } from "./local.ts";

export async function end(
	at: Local,
	params: { peer: string },
): Promise<Answer> {
	const home = groupNamed(params.peer);
	const address = home?.startsWith("@") ? home.slice(1) : params.peer.trim();
	const target = endTarget(
		at.peer.orchestrates,
		at.peer.session,
		address,
		at.presences.all(),
	);
	if ("refused" in target) return answer(`Nothing ended: ${target.refused}.`);
	// A parked session has no process to end, only a holder to wake it.
	if (wokenToEnd(at, target.session)) {
		return answer(
			`${address} was parked, so nothing was signalled; it was woken instead. It ends itself within about two minutes if its quest has ended; otherwise it carries on, and nothing is kept to end it later, so call mesh_end again once it runs.`,
		);
	}
	const ended = await (at.endProcess ?? endByOwner)(
		target.owner,
		`mesh_end from ${at.peer.signature}`,
	);
	if (ended === "gone") {
		if (await resuming(at, target.owner))
			return answer(
				`${address} is resuming as its host starts again, so nothing was signalled and nothing is kept to end it later; it carries on once back, so call mesh_end again once it runs.`,
			);
		return answer(`${address} had already ended; nothing was signalled.`);
	}
	if (ended === "unsure") {
		if (target.owner.session)
			return answer(
				`Nothing ended: ${address}'s host did not confirm the close through its host control socket (unreachable, refused, or no longer the host its presence names), so it was left alone; a shared host is never signalled.`,
			);
		return answer(
			`Nothing ended: this machine can't tell whether pid ${target.owner.pid} is still ${address}'s pi, so it was left alone.`,
		);
	}
	if (target.owner.session)
		return answer(`Asked ${address}'s host to close only that conversation.`);
	return answer(
		`Asked ${address}'s pi (pid ${target.owner.pid}) to quit; its window closes with it.`,
	);
}

/**
 * Whether a hosted conversation that reads gone is one its host is
 * bringing back as it starts again, as mesh_groups would say.
 */
function resuming(at: Local, owner: TickedOwner): Promise<boolean> {
	if (owner.host === undefined || owner.session === undefined)
		return Promise.resolve(false);
	return (at.heldAsk ?? heldOnce())(owner.session, owner.host);
}

/** Whether a parked session was woken for mesh_end, rather than ended. */
function wokenToEnd(at: Local, session: string): boolean {
	const wake = at.wakeParked ?? ((one, why) => askWake(one, why));
	try {
		return wake(session, `mesh-end-${at.peer.signature}`);
	} catch {
		// A holder that can't be asked leaves it to be ended as a process.
		return false;
	}
}

/**
 * Close a hosted conversation, here or through its host's control
 * socket, or signal a plain pi only while its recorded process identity
 * still matches.
 */
const endByOwner: EndProcess = async (owner, by) => {
	const standing = await tickedStanding(owner);
	if (standing === "gone") return "gone";
	if (standing === "unknown") return "unsure";
	if (owner.session !== undefined && !hostedHere(owner))
		return closeThroughHost(owner, by);
	try {
		await endSession(owner, `closed, asked by ${by}`);
		return "ended";
	} catch {
		// A failed local close is not known to have landed, and a hosted
		// owner must never be mistaken for a process safe to signal.
		return owner.session ? "unsure" : "gone";
	}
};
