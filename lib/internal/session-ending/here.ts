/**
 * What this machine knows of itself that spares its own sessions from
 * an ask to end them, each read from what owns it.
 *
 * A log-out leaves the user's services running when logind says the
 * user lingers and that it kills no user processes at a log-out: the pi
 * hosts are user services and each holder runs in a scope under the
 * user's manager, so both outlive it (optimus, 19 November). And a
 * session holds the machine while the node lists a standing hold of its
 * own to the machine's group, which is how a disruption is scheduled:
 * the hold parks every session first.
 *
 * Anything that can't be read spares nothing, as on a Mac, where there
 * is no logind, or where mycelium can't be run: a guess that spared a
 * session would be the one that ends its run.
 */

import type { Exec } from "../../core/exec/index.ts";
import { ALL } from "../../mesh/group.ts";
import { isRecord } from "../record.ts";

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
 * Whether `address` holds this machine: any of its nodes, at `sockets`,
 * lists a hold from it to the machine's group that stands at `now`.
 */
export async function holdsMachine(
	exec: Exec,
	sockets: readonly string[],
	address: string | undefined,
	now: number,
): Promise<boolean> {
	if (address === undefined) return false;
	const each = await Promise.all(
		sockets.map((socket) =>
			said(exec, "mycelium", ["unanswered", "--socket", socket]),
		),
	);
	return each.some((lines) =>
		(lines ?? "")
			.split("\n")
			.some((line) => isStandingHoldFrom(line, address, now)),
	);
}

/** Whether a line the node lists is a hold from `address` to the machine. */
function isStandingHoldFrom(
	line: string,
	address: string,
	now: number,
): boolean {
	let one: unknown;
	try {
		one = JSON.parse(line);
	} catch {
		// A line this reader doesn't know is no hold, which spares nothing.
		return false;
	}
	if (!isRecord(one)) return false;
	const { intent, from, groups, until } = one;
	const ends = typeof until === "string" ? Date.parse(until) : Number.NaN;
	return (
		intent === "hold" &&
		from === address &&
		Array.isArray(groups) &&
		groups.includes(ALL) &&
		ends > now
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
