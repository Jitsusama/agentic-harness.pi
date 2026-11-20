/**
 * What this machine knows of itself that spares its own sessions from
 * an ask to end them, each read from what owns it.
 *
 * A log-out leaves the user's services running when logind says the
 * user lingers and that it kills no user processes at a log-out: the pi
 * hosts are user services and each holder runs in a scope under the
 * user's manager, so both outlive it (optimus, 19 November). And a
 * disruption is scheduled by a hold asking every session to answer it
 * once parked: a session parked for the asker is one whose lease board
 * says it waits on a standing hold of the asker's that names a
 * disruption. A hold alone says nothing of who parked, and nearly every
 * hold reaches the whole machine, whatever it is about (council of
 * 20 November), so neither its sending nor its reach is taken as more.
 *
 * Anything that can't be read spares nothing, as on a Mac, where there
 * is no logind, or a board that can't be read: a guess that spared a
 * session would be the one that ends its run.
 */

import { join } from "node:path";
import type { Exec } from "../../core/exec/index.ts";
import {
	createBoard,
	type Holding,
	isCurrent,
	ownerOf,
} from "../../mesh/lease.ts";
import { senderOf } from "../../mesh/transport.ts";
import { everyRealmsDir } from "../paths.ts";

/**
 * What a hold's opening words say when it is about ending the machine's
 * sessions: a reboot, restart, shutdown, power-off, log-out or switch
 * of users, in any form of the word.
 */
const DISRUPTS =
	/\b(?:reboot|restart|shut(?:ting)?[ -]?down|power(?:ing)?[ -]?off|log(?:ging)?[ -]?out|sign(?:ing)?[ -]?out|switch(?:ing)? users)/i;

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
 * The sessions parked for `address`, by session id: those `board` says
 * wait, at `now`, on a hold of its that still stands and whose opening
 * words name a disruption. None when there is no address.
 */
export function parkedFor(
	board: readonly Holding[],
	address: string | undefined,
	now: number,
): Set<string> {
	if (address === undefined) return new Set();
	const disruptions = new Set(
		board
			.flatMap((holding) => holding.leases)
			.filter(
				(lease) =>
					lease.kind === "hold" &&
					isCurrent(lease, now) &&
					senderOf(lease.subject) === address &&
					DISRUPTS.test(lease.why ?? ""),
			)
			.map((lease) => lease.subject),
	);
	return new Set(
		board
			.filter((holding) =>
				holding.leases.some(
					(lease) =>
						lease.kind === "wait" &&
						isCurrent(lease, now) &&
						disruptions.has(lease.subject),
				),
			)
			.map(ownerOf),
	);
}

/**
 * Every realm's lease board on this machine, as one: a hold and the
 * waits on it are in the realm its sender is in, and a reboot ends
 * every realm's sessions.
 */
export function machineBoard(): Holding[] {
	return everyRealmsDir("state", "mesh-workflow").flatMap((dir) =>
		createBoard(join(dir, "leases")).all(),
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
