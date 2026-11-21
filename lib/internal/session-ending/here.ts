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
 * boot, while /run/nextroot holds a tree, so then the parked can't be
 * told, and the refusal says why.
 */

import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readdirSync,
	readFileSync,
	type Stats,
} from "node:fs";
import { join } from "node:path";
import type { Exec } from "../../core/exec/index.ts";
import type { HostRegistry } from "../../core/session/host.ts";
import { hostRegistryOf } from "../../core/session/registry.ts";
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
 * It fails, saying why, while `nextRoot` holds a tree or can't be read,
 * since a reboot then keeps the boot and every marker with it.
 */
export async function parkedHere(
	marked: (session: string) => boolean = (session) => markedThisBoot(session),
	running: () => Promise<Set<string>> = () => runningInHosts(),
	nextRoot = "/run/nextroot",
): Promise<Set<string>> {
	const soft = softensAReboot(nextRoot);
	if (soft) throw new Error(soft);
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
 * of every session, so it fails the read, and nothing is spared; unless
 * it was last written before `booted`, when its host went with that
 * boot, as a crash can leave a list torn.
 */
export async function runningInHosts(
	dir: string = stateDir("hosts"),
	standing: (owner: TickedOwner) => Promise<Standing> = (owner) =>
		tickedStanding(owner),
	booted: Booted = machineBooted,
): Promise<Set<string>> {
	const running = new Set<string>();
	for (const list of hostLists(dir, booted)) {
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
 * Every host list in `dir`, failing on one that can't be read, or isn't
 * a file: its host may run any session. Each is opened without blocking
 * or following a link, and judged a file on what was opened, so no read
 * can hang on a pipe put in its place. A list gone since the folder was
 * read went with its host, one written before `booted` with that boot's,
 * and one whose host's process, named in its name, is gone with it, so
 * each is passed over.
 */
function hostLists(dir: string, booted: Booted): HostRegistry[] {
	let names: string[];
	try {
		names = readdirSync(dir).filter((name) => name.endsWith(".json"));
	} catch (error) {
		if (codeOf(error) === "ENOENT") return [];
		throw error;
	}
	return names.flatMap((name) => {
		const path = join(dir, name);
		// Only a name's own characters, so a name can't speak in a refusal.
		const shown = join(dir, name.replace(/[^\w.-]/g, "?"));
		const text = listText(path, shown);
		if (text === undefined) return [];
		const list = hostRegistryOf(text);
		if (list) return [list];
		const now = statOf(path);
		if (!now) return [];
		const boot = booted();
		if (boot !== undefined && now.mtimeMs < boot) return [];
		if (hostGone(name)) return [];
		throw new Error(`the host list ${shown} can't be read`);
	});
}

/**
 * What the list at `path` holds, read through one descriptor opened
 * without blocking or following a link, or nothing once it is gone.
 * Anything but a file fails, said as `shown`.
 */
function listText(path: string, shown: string): string | undefined {
	let fd: number;
	try {
		fd = openSync(
			path,
			constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
		);
	} catch (error) {
		if (codeOf(error) === "ENOENT") return undefined;
		if (codeOf(error) === "ELOOP")
			throw new Error(`the host list ${shown} isn't a file`);
		throw new Error(`the host list ${shown} can't be read`);
	}
	try {
		if (!fstatSync(fd).isFile())
			throw new Error(`the host list ${shown} isn't a file`);
		return readFileSync(fd, "utf8");
	} finally {
		closeSync(fd);
	}
}

/**
 * Whether the host a list's `name` names, as `<pid>-<start>.json`, is
 * provably gone: no process has its pid. A pid since reused leaves it
 * counted, which spares nothing.
 */
function hostGone(name: string): boolean {
	const pid = Number(/^(\d+)-\d+\.json$/.exec(name)?.[1]);
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		return codeOf(error) === "ESRCH";
	}
}

/** What `path` is, unfollowed, or nothing once it is gone. */
function statOf(path: string): Stats | undefined {
	try {
		return lstatSync(path);
	} catch (error) {
		if (codeOf(error) === "ENOENT") return undefined;
		throw error;
	}
}

/**
 * Why a reboot might go soft into `root`, a next root: it holds a tree,
 * or can't be read and so might. Nothing where it is empty or absent.
 */
function softensAReboot(root: string): string | undefined {
	try {
		return readdirSync(root).length > 0
			? `${root} holds a tree, so a reboot would keep this boot`
			: undefined;
	} catch (error) {
		return codeOf(error) === "ENOENT"
			? undefined
			: `${root} can't be read, so a reboot might keep this boot`;
	}
}

/** The code a failed file call carries, such as ENOENT. */
function codeOf(error: unknown): unknown {
	return error instanceof Error && "code" in error ? error.code : undefined;
}

/**
 * What `read` answers within `patienceMs`, its clock started before the
 * read is, failing once that is out, so a read stuck on a slow disk
 * spares nothing rather than holding up the reply. A read that holds
 * the thread, as a synchronous file read does, can't be cut short, but
 * one that answers past its patience fails all the same.
 */
export async function withinPatience<T>(
	read: () => Promise<T>,
	patienceMs: number,
): Promise<T> {
	const late = () => new Error(`what spares wasn't read in ${patienceMs} ms`);
	// The monotonic clock, which a step of the wall clock can't move.
	const started = performance.now();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const out = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(late()), patienceMs);
	});
	try {
		const answer = await Promise.race([Promise.resolve().then(read), out]);
		if (performance.now() - started > patienceMs) throw late();
		return answer;
	} finally {
		clearTimeout(timer);
	}
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
