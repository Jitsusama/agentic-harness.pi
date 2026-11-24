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
 * as it always has. A close that fails is told to `failed`, which a
 * host's close does after this returns, as it isn't awaited; plain pi's
 * shutdown throws to the caller where no `failed` is given. One that
 * lands is told to `closed`, plain pi's once its shutdown is asked, so
 * a caller waiting on the close can tell one that hangs.
 */
export function endConversation(
	ctx: Ending,
	by: string,
	failed?: (error: unknown) => void,
	closed?: () => void,
): void {
	const host = hosted();
	if (!host) {
		if (!failed) {
			ctx.shutdown();
			closed?.();
			return;
		}
		try {
			ctx.shutdown();
		} catch (error) {
			failed(error);
			return;
		}
		closed?.();
		return;
	}
	const sessionId = ctx.sessionManager.getSessionId();
	// Not awaited: the close ends this very conversation, whose extension
	// may be the one asking.
	Promise.resolve()
		.then(() => host.close(sessionId, `closed, asked by ${by}`))
		.then(
			() => {
				try {
					closed?.();
				} catch (telling) {
					// It closed; only telling so failed, which isn't a failed close.
					process.stderr.write(
						`pi-host: ${sessionId}'s close couldn't be told: ${messageOf(telling)}\n`,
					);
				}
			},
			(error: unknown) => {
				// A close that failed leaves the conversation held, as the host
				// keeps every failed close (SessionHost.close); the host's journal,
				// its standard error, says so. pi's shutdown is no fallback: in a
				// host it ends in this same close, only without saying who asked.
				process.stderr.write(
					`pi-host: ${sessionId} didn't close, asked by ${by}: ${messageOf(error)}\n`,
				);
				// Thrown here, it would be a rejection nothing handles.
				try {
					failed?.(error);
				} catch (telling) {
					process.stderr.write(
						`pi-host: ${sessionId}'s failed close couldn't be told: ${messageOf(telling)}\n`,
					);
				}
			},
		);
}

/**
 * What was thrown, in words; never throws, since it is said from the
 * close's own handlers, where a throw is a rejection nothing handles.
 */
function messageOf(error: unknown): string {
	try {
		return error instanceof Error ? String(error.message) : String(error);
	} catch {
		// What was thrown can't say itself; that the close failed still is.
		return "something was thrown that can't be put in words";
	}
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
