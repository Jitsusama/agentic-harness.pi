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
 * is no logind, or a presence or host list that can't be read, or a
 * read past its patience: a guess that spared a session would be the
 * one that ends its run. A `systemctl reboot` goes soft, keeping the
 * boot, while /run/nextroot holds a tree, so then no marker counts.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Exec } from "../../core/exec/index.ts";
import type { HostRegistry } from "../../core/session/host.ts";
import { hostRegistryAt } from "../../core/session/registry.ts";
import { createPresences } from "../../mesh/presence.ts";
import { type Booted, machineBooted } from "../machine/booted.ts";
import { everyRealmsDir, stateDir } from "../paths.ts";
import {
	type Standing,
	type TickedOwner,
	tickedStanding,
} from "../process-ticks.ts";
import { isParked, parkFolder } from "../session/park.ts";

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
 * conversation on one. `marked` reads the marker. A session a host
 * still runs is left out: a park closes its conversation, so a host
 * listing it busy or idle has woken it, or its park never landed.
 * None counts while `nextRoot` holds a tree, since a reboot then keeps
 * the boot and every marker with it.
 */
export async function parkedHere(
	marked: (session: string) => boolean = (session) => markedThisBoot(session),
	running: () => Promise<Set<string>> = () => runningInHosts(),
	nextRoot = "/run/nextroot",
): Promise<Set<string>> {
	if (holdsATree(nextRoot)) return new Set();
	const [each, hosted] = await Promise.all([
		Promise.all(
			everyRealmsDir("state", "mesh-workflow").map((mesh) =>
				createPresences(join(mesh, "presence")).listed(),
			),
		),
		running(),
	]);
	return new Set(
		each
			.flat()
			.filter(
				(one) =>
					one.state === "parked" &&
					!hosted.has(one.session) &&
					marked(one.session),
			)
			.map((one) => one.session),
	);
}

/**
 * The conversations a host lists busy or idle, from every host's list
 * whose process isn't known to be gone: one that can't be judged still
 * counts, since a host it can't rule out may be running them. A file
 * that doesn't read as a host's list can't be told apart from a list
 * of every session, so it fails the read, and nothing is spared.
 */
export async function runningInHosts(
	dir: string = stateDir("hosts"),
	standing: (owner: TickedOwner) => Promise<Standing> = (owner) =>
		tickedStanding(owner),
): Promise<Set<string>> {
	const running = new Set<string>();
	for (const list of hostLists(dir)) {
		const { session: _session, ...hostProcess } = list.owner;
		if ((await standing(hostProcess)) === "gone") continue;
		for (const one of list.sessions) {
			if (one.state !== "parked") running.add(one.id);
		}
	}
	return running;
}

/**
 * Whether `session`'s park marker is from this boot. Parking's own
 * reader counts every marker where the boot can't be told, as on a Mac;
 * here that spares nothing, since a marker from an earlier boot would
 * spare a session that started again since.
 */
export function markedThisBoot(
	session: string,
	folder: string = parkFolder(),
	booted: Booted = machineBooted,
): boolean {
	const boot = booted();
	return boot !== undefined && isParked(session, folder, () => boot);
}

/**
 * Every host list in `dir`, failing on one that can't be read: its
 * host may run any session. A list gone since the folder was read went
 * with its host, so it is passed over.
 */
function hostLists(dir: string): HostRegistry[] {
	let names: string[];
	try {
		names = readdirSync(dir).filter((name) => name.endsWith(".json"));
	} catch (error) {
		if (codeOf(error) === "ENOENT") return [];
		throw error;
	}
	return names.flatMap((name) => {
		const path = join(dir, name);
		const list = hostRegistryAt(path);
		if (list) return [list];
		if (!existsSync(path)) return [];
		throw new Error(`the host list ${name} can't be read`);
	});
}

/**
 * Whether `root` holds anything, as a next root a reboot would soft-boot
 * into; one that can't be read might, so it does.
 */
function holdsATree(root: string): boolean {
	try {
		return readdirSync(root).length > 0;
	} catch (error) {
		return codeOf(error) !== "ENOENT";
	}
}

/** The code a failed file call carries, such as ENOENT. */
function codeOf(error: unknown): unknown {
	return error instanceof Error && "code" in error ? error.code : undefined;
}

/**
 * What `read` answers within `patienceMs`, failing once that is out, so
 * a read stuck on a slow disk spares nothing rather than holding up the
 * reply.
 */
export function withinPatience<T>(
	read: Promise<T>,
	patienceMs: number,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const out = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new Error(`what spares wasn't read in ${patienceMs} ms`)),
			patienceMs,
		);
	});
	return Promise.race([read, out]).finally(() => clearTimeout(timer));
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
