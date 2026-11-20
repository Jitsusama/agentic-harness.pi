/**
 * What this machine knows of itself that spares its own sessions from
 * an ask to end them, each read from what owns it.
 *
 * A log-out leaves the user's services running when logind says the
 * user lingers and that it kills no user processes at a log-out: the pi
 * hosts are user services and each holder runs in a scope under the
 * user's manager, so both outlive it (optimus, 19 November). And a
 * session parks only once it is idle with nothing of its own still out,
 * no run, background job, open prompt or unsent text, and then holds
 * nothing an ending could lose (session/park.ts): its presence says so,
 * and its marker from this boot, which a woken session clears as it
 * starts, says it still is. A presence alone outlives what it says, a
 * boot or a wake, so the mesh's own readers ask for both, and so does
 * this (council of 20 November, round 4).
 * Neither a hold nor an answer to one says a session parked, since a
 * peer answers a hold to say it can't hold as readily as that it has,
 * and the mesh moves an answer onto a hold that supersedes the one it
 * answered (council of 20 November, round 3).
 *
 * Anything that can't be read spares nothing, as on a Mac, where there
 * is no logind, or a presence that can't be read: a guess that spared
 * a session would be the one that ends its run.
 */

import { join } from "node:path";
import type { Exec } from "../../core/exec/index.ts";
import { createPresences } from "../../mesh/presence.ts";
import { everyRealmsDir } from "../paths.ts";
import { isParked } from "../session/park.ts";

/**
 * Whether a log-out here leaves the services of `user`, a name or a
 * uid, running: logind says the user lingers and kills no user
 * processes.
 */
export async function logOutSpares(exec: Exec, user: string): Promise<boolean> {
	const [linger, kills] = await Promise.all([
		said(exec, "loginctl", ["show-user", user, "--property=Linger", "--value"]),
		said(exec, "busctl", [
			"get-property",
			"org.freedesktop.login1",
			"/org/freedesktop/login1",
			"org.freedesktop.login1.Manager",
			"KillUserProcesses",
		]),
	]);
	return linger === "yes" && kills === "b false";
}

/**
 * The sessions, by id, whose presence kept here in any realm says they
 * parked and whose marker from this boot says they still are, each
 * realm's presences read off the thread, since a host runs every
 * conversation on one. `marked` reads the marker.
 */
export async function parkedHere(
	marked: (session: string) => boolean = (session) => isParked(session),
): Promise<Set<string>> {
	const each = await Promise.all(
		everyRealmsDir("state", "mesh-workflow").map((mesh) =>
			createPresences(join(mesh, "presence")).listed(),
		),
	);
	return new Set(
		each
			.flat()
			.filter((one) => one.state === "parked" && marked(one.session))
			.map((one) => one.session),
	);
}

/** What `command` printed, trimmed, or nothing when it failed or can't run. */
async function said(
	exec: Exec,
	command: string,
	args: string[],
): Promise<string | undefined> {
	try {
		const result = await exec(command, args);
		return result.code === 0 ? result.stdout.trim() : undefined;
	} catch {
		// A command that can't be started says nothing, which spares nothing.
		return undefined;
	}
}
