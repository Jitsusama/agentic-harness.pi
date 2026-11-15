/**
 * The process that owns a session holds its log open, read-only, for as
 * long as it owns it: a lone pi for its one session, a host for each it
 * hosts, since this runs inside each. Mycelium then believes a
 * presence's claim to a session only where its owner holds that log,
 * read from `/proc/<pid>/fd` (5HJZ8Z [9a66b4c0], 15 November). Nothing
 * else in a pi names its session: no variable at its start, nothing on
 * its command line, and pi opens its log only to write.
 *
 * It proves habit, not identity: any process of the person's could open
 * the log, so it tells a confused helper from the owner, and the node
 * binds a session to its first proved owner for the rest. Node opens
 * every file close-on-exec, so a command the session starts never
 * inherits it.
 *
 * pi writes a new session's log only once it has something to keep, so
 * the log is taken up at the start and again at each run's end until it
 * is there. A fork, a resume or a new session names another log, which
 * is held in place of the old.
 */

import { closeSync, openSync } from "node:fs";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

/** The log held, and its descriptor. */
interface Held {
	readonly path: string;
	readonly fd: number;
}

/** Hold this pi's session log open while it owns it. */
export function holdSessionLog(pi: Pick<ExtensionAPI, "on">): void {
	let held: Held | undefined;
	const letGo = () => {
		if (held === undefined) return;
		try {
			closeSync(held.fd);
		} catch {
			// Already closed: nothing is held either way.
		}
		held = undefined;
	};
	const follow = (ctx: Pick<ExtensionContext, "sessionManager">) => {
		const path = ctx.sessionManager.getSessionFile();
		if (held?.path === path) return;
		letGo();
		if (path === undefined) return;
		try {
			held = { path, fd: openSync(path, "r") };
		} catch {
			// Not written yet: taken up at the next run's end.
		}
	};
	pi.on("session_start", (_event, ctx) => follow(ctx));
	pi.on("agent_end", (_event, ctx) => follow(ctx));
	pi.on("session_shutdown", () => letGo());
}
