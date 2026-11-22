/**
 * What a hosted session's tools tell its host of the fence they hold it
 * to, so the host's record says what really runs under it. The shell
 * draws its sandbox once as it loads, so a variable or stage listing set
 * later waits for its next start; pi's file tools judge each call by the
 * environment as it is then. The host keeps the loosest any said, and
 * names it only once the present runner's shell and file guard both have,
 * so the record never
 * reads tighter than the tools run (ISXEG8's condition 2, 19 November).
 */

import {
	type FenceTeller,
	type Host,
	hosted,
} from "../../core/session/host.ts";
import type { FenceKind } from "../../mesh/presence.ts";
import type { Sandbox } from "./sandbox.ts";

/** The fence `sandbox` puts commands under, as a host's record names it. */
export function fenceOf(sandbox: Sandbox): FenceKind {
	// A refused sandbox runs no command at all, as tight as any fence.
	if (sandbox.kind === "refused" || sandbox.kind === "strict") return "strict";
	return sandbox.kind === "fence" ? "fence" : "none";
}

/** Why a tool refuses what it would run when its host couldn't say its fence. */
export const FENCE_UNSAID =
	"This session's pi host couldn't write the fence it runs under into its record, so nothing runs that the record would show tighter than it is. Until the person frees room where pi keeps its state (its state folder, ~/.local/state/pi unless XDG_STATE_HOME moves it) or puts right what keeps it from being written, every command and file tool, reads included, is refused: stop and tell them so, rather than trying again.";

/**
 * Tell the host holding this session that its shell, or another tool,
 * holds it to `fence`. False when the host couldn't write it, or broke
 * telling while it still holds the session, so the tool refuses what
 * it would run; true outside a host, in a host that keeps no record,
 * or one that holds no such session, whose record then names no fence
 * for it, so the node refuses its carry.
 */
export function tellHostFence(
	fence: FenceKind,
	by: FenceTeller,
	env: NodeJS.ProcessEnv = process.env,
	host: Host | undefined = hosted(),
): boolean {
	const session = env.PI_SESSION_ID;
	if (!host?.fenced || !session) return true;
	try {
		return host.fenced(session, fence, by);
	} catch {
		// A tell that broke partway may have left the record tighter than
		// the tool runs; only a session the host no longer holds is named
		// nowhere.
		try {
			return host.holds(session) === undefined;
		} catch {
			return false;
		}
	}
}

/**
 * Tell the host holding `session` that a guard of its runner has shut
 * down, as pi does to a runner it reloads, so its record names no fence
 * until the next runner's shell and file guard say one. The session is
 * the one the guard heard as its runner started, since a context may
 * not be read once its runner is gone. Nothing outside a host.
 */
export function tellHostLeft(
	session: string | undefined,
	host: Host | undefined = hosted(),
): void {
	if (!host?.left || !session) return;
	try {
		host.left(session);
	} catch {
		// The session is gone from the host, and its record with it.
	}
}
