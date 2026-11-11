/** A session's owner: the pi process, or one conversation within a host. */
import {
	type TickedOwner,
	tickedOwnerNow,
	tickedStanding,
} from "../../internal/process-ticks.ts";
import { isOwner } from "../process/index.ts";
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

/** What ending a conversation needs of its pi context. */
export interface Ending {
	shutdown(): void;
	readonly sessionManager: { getSessionId(): string };
}

/**
 * End the conversation `ctx` runs, as pi's shutdown does, saying who
 * asked. pi's shutdown carries no reason, so in a host it goes through
 * the host's close, whose journal line names `by`; plain pi shuts down
 * as it always has.
 */
export function endConversation(ctx: Ending, by: string): void {
	const host = hosted();
	if (!host) {
		ctx.shutdown();
		return;
	}
	const sessionId = ctx.sessionManager.getSessionId();
	// Not awaited: the close ends this very conversation, whose extension
	// may be the one asking.
	Promise.resolve()
		.then(() => host.close(sessionId, `closed, asked by ${by}`))
		.catch((error: unknown) => {
			// A close that failed leaves the conversation held; the host's
			// journal, its standard error, says so.
			process.stderr.write(
				`pi-host: ${sessionId} didn't close, asked by ${by}: ${error instanceof Error ? error.message : String(error)}\n`,
			);
		});
}

/** Close a local hosted conversation; never send a host a session's SIGTERM. */
export async function endSession(
	owner: TickedOwner,
	why = "ended",
): Promise<void> {
	if (!isOwner(owner))
		throw new Error("Cannot end a session with an invalid owner");
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
	const standing = await tickedStanding(owner);
	if (standing !== "running") {
		throw new Error(
			`Cannot end session: recorded process owner is ${standing}`,
		);
	}
	process.kill(owner.pid, "SIGTERM");
}
