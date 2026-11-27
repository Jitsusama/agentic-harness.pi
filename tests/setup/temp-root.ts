/**
 * Give each test run one temp directory, and remove it when the run
 * ends.
 *
 * Tests make scratch directories through `os.tmpdir()` all over the
 * suite, and cleaning each up relied on the test or a worker's exit
 * handler. Neither held: vitest ends its workers without running their
 * exit handlers, and a single day of runs left over two thousand XDG
 * sandboxes and fifty git fixture templates behind. Every leaked repo
 * also kept a git fsmonitor daemon alive wherever fsmonitor is on.
 *
 * This runs once in the main process, before any worker starts, so
 * pointing TMPDIR at the run's directory reaches every worker and
 * every process a test spawns. The teardown then removes whatever
 * they left, including anything a test written tomorrow forgets.
 *
 * On a Mac whose TMPDIR is its own default, the directory goes under
 * /tmp: that default sits so deep under /var/folders that the sockets the
 * host's tests make in it run past the 104 bytes a Unix socket's path may
 * take. A TMPDIR a session set stays, since a fenced run may write
 * nowhere else.
 */

import {
	lstatSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Where a Mac's own TMPDIR sits, as set and as resolved. */
const MAC_DEFAULT_TMPDIR = /^(\/private)?\/var\/folders\//;

/** The folder a run's temp directory goes in, on `platform`. */
export function runRootBase(platform: NodeJS.Platform, base: string): string {
	return platform === "darwin" && MAC_DEFAULT_TMPDIR.test(base) ? "/tmp" : base;
}

/**
 * What names the run's short folder, for a test whose sockets wouldn't
 * fit under the run's directory, as under any session's TMPDIR, which
 * this run's own folder makes 18 bytes longer still.
 */
export const SOCKET_ROOT = "PI_TEST_SOCKET_ROOT";

/** Where the short folders go, and how each is named there. */
const SHORT_PARENT = "/tmp";
const SHORT_PREFIX = "vs-";

/**
 * A name as the setup's mkdtemp makes it, the prefix and six letters or
 * digits, so a sweep never reads a folder of the developer's that merely
 * starts with the prefix.
 */
const SHORT_NAME = /^vs-[A-Za-z0-9]{6}$/;

/**
 * The file in a short folder naming the run that made it: its pid, then
 * on the next line the pid namespace that pid belongs to.
 */
const RUN_FILE = "run.pid";

/** A run file as the setup writes it: a pid, then its namespace. */
const RUN_RECORD = /^([1-9]\d*)\n([^\n]*)\n$/;

/**
 * How long a folder with no run file may be a run's still starting: its
 * setup writes the file just after making the folder, so an hour on, its
 * run died between the two, and the folder, empty, is taken.
 */
export const STARTING_MS = 60 * 60 * 1000;

/**
 * How long before a short folder whose run this sweep can't judge is
 * taken: one whose pid another namespace wrote, or one no namespace was
 * named for on Linux. Past any run's length, so such a folder goes in
 * the end, while one whose pid this sweep can judge as live stays.
 */
export const STALE_MS = 24 * 60 * 60 * 1000;

/** The errors that mean /tmp may not be written, rather than a fault. */
const REFUSED = new Set(["EACCES", "EPERM", "EROFS"]);

/**
 * Point TMPDIR at the run's own directory, name a short one for sockets,
 * and remove both at the end, so what a killed worker left in either
 * goes too. A run killed outright leaves its short folder in /tmp, out
 * of any session's scratch, so each run first sweeps those whose run is
 * gone.
 */
export default function setup(): () => void {
	const previous = process.env.TMPDIR;
	const previousSockets = process.env[SOCKET_ROOT];
	sweepShortFolders(SHORT_PARENT);
	const root = mkdtempSync(
		join(runRootBase(process.platform, tmpdir()), "vitest-run-"),
	);
	process.env.TMPDIR = root;
	let sockets: string | undefined;
	try {
		sockets = socketRoot();
	} catch (error) {
		// No teardown comes back to remove the root or give TMPDIR back.
		if (previous === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = previous;
		rmSync(root, { recursive: true, force: true });
		throw error;
	}
	// One inherited from an outer run names a folder this run doesn't own.
	if (sockets === undefined) delete process.env[SOCKET_ROOT];
	else process.env[SOCKET_ROOT] = sockets;
	return () => {
		if (previous === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = previous;
		if (previousSockets === undefined) delete process.env[SOCKET_ROOT];
		else process.env[SOCKET_ROOT] = previousSockets;
		// The short folder first and apart, since it sits in the shared
		// /tmp: a root a test left unremovable mustn't keep it there.
		try {
			if (sockets !== undefined)
				rmSync(sockets, { recursive: true, force: true });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	};
}

/**
 * The run's short folder, 14 bytes under /tmp, naming the run that made
 * it; or none where /tmp may not be written, as under the sandbox, which
 * grants only TMPDIR. A test needing one then fails as it would have,
 * while every other test still runs. Any other error is a fault, and
 * fails the run rather than quietly leaving it without one, removing the
 * folder if it was made.
 */
function socketRoot(): string | undefined {
	let folder: string;
	try {
		folder = mkdtempSync(join(SHORT_PARENT, SHORT_PREFIX));
	} catch (error) {
		if (REFUSED.has((error as NodeJS.ErrnoException).code ?? ""))
			return undefined;
		throw error;
	}
	try {
		writeFileSync(
			join(folder, RUN_FILE),
			`${process.pid}\n${pidNamespace()}\n`,
		);
	} catch (error) {
		rmSync(folder, { recursive: true, force: true });
		throw error;
	}
	return folder;
}

/** Where and when a sweep runs: its pid namespace, platform and time. */
export interface Sweeper {
	readonly namespace: string;
	readonly now: number;
	readonly platform?: NodeJS.Platform;
}

/**
 * Remove the short folders in `parent` that this account's runs made and
 * that outlived them, reading only names as the setup makes them.
 *
 * - A pid is judged only in the namespace that wrote it, since one from
 *   another, as each fenced command on Linux has, names nothing here, or
 *   someone else. An empty namespace on Linux means /proc wasn't there to
 *   name one, so it isn't judged either. Such a folder stays until
 *   `STALE_MS` has passed.
 * - A judged pid that lives keeps its folder at any age, as a watch run's
 *   must; a reused pid's folder then stays until the pid ends or the
 *   machine restarts, which costs a few bytes rather than a live run.
 * - A folder with no run file may be a run's starting now, and stays for
 *   `STARTING_MS`; after that it goes only if empty.
 * - A run file not as the setup writes it is no run's, and stays.
 */
export function sweepShortFolders(
	parent: string,
	sweeper: Sweeper = { namespace: pidNamespace(), now: Date.now() },
): void {
	let names: string[];
	try {
		names = readdirSync(parent);
	} catch {
		return;
	}
	const uid = process.getuid?.();
	for (const name of names) {
		if (!SHORT_NAME.test(name)) continue;
		const folder = join(parent, name);
		try {
			const stat = lstatSync(folder);
			if (!stat.isDirectory() || stat.uid !== uid) continue;
			const fate = fateOf(folder, sweeper.now - stat.mtimeMs, sweeper);
			if (fate === "removed") rmSync(folder, { recursive: true, force: true });
			// Fails on anything inside, which then stays.
			else if (fate === "removed if empty") rmdirSync(folder);
		} catch {
			// Gone, unreadable or not empty: not this sweep's to take.
		}
	}
}

/** What a sweep does with a short folder. */
type Fate = "kept" | "removed" | "removed if empty";

/** What becomes of `folder`, `age` old, as `sweeper` can tell its run. */
function fateOf(folder: string, age: number, sweeper: Sweeper): Fate {
	let record: string;
	try {
		record = readFileSync(join(folder, RUN_FILE), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "kept";
		return age > STARTING_MS ? "removed if empty" : "kept";
	}
	const run = RUN_RECORD.exec(record);
	if (run === null) return "kept";
	const [, pid, writer] = run;
	if (judgeable(writer ?? "", sweeper))
		return alive(Number(pid)) ? "kept" : "removed";
	return age > STALE_MS ? "removed" : "kept";
}

/**
 * Whether a pid `writer`'s namespace wrote means the same process to
 * `sweeper`: written in its own namespace, and not the empty one on
 * Linux, where a run with no /proc to read names none whatever its
 * namespace.
 */
function judgeable(writer: string, sweeper: Sweeper): boolean {
	const platform = sweeper.platform ?? process.platform;
	return (
		writer === sweeper.namespace && !(writer === "" && platform === "linux")
	);
}

/**
 * This process's pid namespace, as Linux names it; empty where there is
 * none to name, as on a Mac, whose processes all share one.
 */
function pidNamespace(): string {
	try {
		return readlinkSync("/proc/self/ns/pid");
	} catch {
		return "";
	}
}

/** Whether a process with `pid` exists, whoever's it is. */
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}
