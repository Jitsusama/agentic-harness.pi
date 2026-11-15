/**
 * A fleet's bookkeeping: writing it down without costing it, and
 * reading which conversation and owner it belongs to.
 *
 * Apart from the tool and the session-start upkeep because both lean on
 * it, and because what it guards against (a ledger write that throws,
 * a context that is not pi's) changes for reasons neither of them does.
 */

import { type SessionRef, sessionCell } from "../../lib/core/session/index.ts";
import { tickFacts } from "../../lib/internal/process-ticks.ts";
import { type FleetRun, whoIsWaiting } from "../../lib/subagent/fleet.ts";
import type { Aside } from "../../lib/ui/aside.ts";

/**
 * Do a piece of bookkeeping, and say so if it fails.
 *
 * Bookkeeping must never cost a fleet. A ledger write that throws
 * would take down a dispatch that is otherwise fine, or turn the end
 * of an expensive fleet into an exception that throws away everything
 * it found. Said out loud rather than swallowed, because what a
 * failure here costs is a fleet nothing protects or a fleet nothing
 * ever releases, and neither is visible from anywhere else.
 */
export async function recordOrSay(
	work: () => Promise<void>,
	cost: string,
	say: Aside,
): Promise<void> {
	try {
		// Called here rather than taken as a started promise, so a
		// synchronous throw on the way in is caught by the guard it was
		// meant for rather than escaping past it.
		await work();
	} catch (error) {
		say(
			`[subagent-workflow] ${cost}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

const OWNER_CELL = "agentic-harness.subagent-workflow.owner.v1";

/**
 * Who is waiting in the conversation `session` names, asked once;
 * left out, the conversation the host is running, as a context built
 * by something other than pi names none.
 *
 * The answer cannot change and asking costs a subprocess, so it is
 * kept, in the conversation's own cell: in a host, each conversation is
 * an owner of its own. The library is left stateless, since a cache
 * belongs to a session rather than to a definition. A failure is not
 * kept, because `ps` can miss for a moment under load and caching that
 * turns one slow probe into a session where no fleet is attributed to
 * anybody.
 */
export async function ourOwner(
	session: SessionRef | undefined,
): Promise<FleetRun["owner"]> {
	const cell = sessionCell<NonNullable<FleetRun["owner"]>>(OWNER_CELL, session);
	const kept = cell.get();
	if (kept !== undefined) return kept;
	// The pid left to its default, this process's.
	const owner = await whoIsWaiting(tickFacts, undefined, session);
	if (owner !== undefined) cell.set(owner);
	return owner;
}

/**
 * Whether this context's conversation said anything before this start,
 * as a restored one did. Only such a conversation can have dispatched a
 * fleet that was cut off. A context that can't say counts as one, so it
 * is told what it may be owed.
 */
export function cameBack(ctx: { sessionManager?: unknown }): boolean {
	try {
		const manager = ctx.sessionManager as
			| { getEntries?: () => readonly { type: string }[] }
			| undefined;
		const entries = manager?.getEntries?.();
		return entries === undefined
			? true
			: entries.some((entry) => entry.type === "message");
	} catch {
		// A manager that throws can't say, which counts as having come back.
		return true;
	}
}

/**
 * The pi session this context belongs to, when it says.
 *
 * Guarded, since a context built by something other than pi need not
 * carry a session manager, and a fleet recorded without a session is
 * still a fleet recorded.
 */
export function sessionOf(ctx: {
	sessionManager?: unknown;
}): string | undefined {
	try {
		const manager = ctx.sessionManager as
			| { getSessionId?: () => string | undefined }
			| undefined;
		return manager?.getSessionId?.() || undefined;
	} catch {
		return undefined;
	}
}
