/** A session's owner: the pi process, or one conversation within a host. */
import {
	type TickedOwner,
	tickedOwnerNow,
} from "../../internal/process-ticks.ts";
import { hosted } from "./host.ts";
import { requireSession, type SessionRef } from "./identity.ts";

/** Name the owner for liveness and leases, not merely a sending pid. */
export async function sessionOwner(
	ref?: SessionRef,
): Promise<TickedOwner | undefined> {
	const host = hosted();
	if (!host) return tickedOwnerNow();
	return { ...host.owner, session: requireSession(ref), host: host.key };
}

/** Close a local hosted conversation; never send a host a session's SIGTERM. */
export async function endSession(
	owner: TickedOwner,
	why = "ended",
): Promise<void> {
	if (owner.session !== undefined) {
		const host = hosted();
		if (
			!host ||
			host.key !== owner.host ||
			host.owner.pid !== owner.pid ||
			host.owner.startedAt !== owner.startedAt ||
			host.owner.bootId !== owner.bootId ||
			host.owner.startTicks !== owner.startTicks
		) {
			throw new Error(
				"Hosted session is not in this process: send close through its host control socket",
			);
		}
		await host.close(owner.session, why);
		return;
	}
	process.kill(owner.pid, "SIGTERM");
}
