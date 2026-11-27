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
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmdirSync,
	rmSync,
	unlinkSync,
	utimesSync,
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
 * starts with the prefix. It is the setup's shape, not proof the setup
 * made it: an empty folder of this shape goes after `STARTING_MS`,
 * whoever made it.
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
 * How long a folder with no run file, or an empty one, may be a run's
 * still starting: its setup writes the file just after making the
 * folder, so an hour on, its run died between the two, and the folder,
 * empty but for that file, is taken.
 */
export const STARTING_MS = 60 * 60 * 1000;

/**
 * How long before a short folder whose run this sweep can't judge is
 * taken: one whose pid another namespace wrote, as every other fenced
 * command's on Linux, or one no namespace was named for on Linux. Its
 * age is its last change, which a live run makes every `FRESH_MS` while
 * its process runs. One asleep or stopped this long reads as gone, and
 * remakes its folder at its next touch if a sweep took it.
 */
export const STALE_MS = 24 * 60 * 60 * 1000;

/**
 * How often a live run touches its short folder, so its age is never
 * its run's length: well inside `STALE_MS`, and a timer an hour apart
 * costs the run nothing.
 */
export const FRESH_MS = STARTING_MS;

/**
 * The errors that mean /tmp may not be written, as under the sandbox,
 * rather than a fault.
 */
const REFUSED = new Set(["EACCES", "EPERM", "EROFS"]);

/**
 * The errors that mean /tmp isn't there, or isn't a folder: the host's
 * fault, which is said, though only the tests needing a short folder
 * fail of it.
 */
const MISSING = new Set(["ENOENT", "ENOTDIR"]);

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
	const fresh = sockets === undefined ? undefined : keptFresh(sockets);
	return () => {
		clearInterval(fresh);
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
 * Touch `folder` every `FRESH_MS` while the run lasts, so a sweep reads
 * its age as the time since its run was last seen, not since a test last
 * made a folder in it. Where it's gone, taken by a sweep while the run
 * was asleep or stopped, or by /tmp's clearing, it is made again at the
 * same path, so `SOCKET_ROOT` names a folder again. Unheld, so it never
 * keeps a run going.
 */
function keptFresh(folder: string): NodeJS.Timeout {
	const fresh = setInterval(() => {
		try {
			const now = new Date();
			utimesSync(folder, now, now);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") remade(folder);
			// Otherwise not this run's to touch now; the next tick tries again.
		}
	}, FRESH_MS);
	fresh.unref();
	return fresh;
}

/** Make `folder` again, naming this run, unless another made it first. */
function remade(folder: string): void {
	try {
		mkdirSync(folder, { mode: 0o700 });
	} catch {
		// Another run's at the name, or /tmp refusing: none of this run's.
		return;
	}
	try {
		nameRun(folder);
	} catch {
		// Unnamed, it reads as a run's starting, and goes after an hour.
	}
}

/** Write the run file in `folder`, naming this run and its namespace. */
function nameRun(folder: string): void {
	writeFileSync(join(folder, RUN_FILE), `${process.pid}\n${pidNamespace()}\n`);
}

/**
 * The run's short folder, 14 bytes under /tmp, naming the run that made
 * it; or none where /tmp may not be written or isn't there, as under the
 * sandbox, which grants only TMPDIR. A test needing one then fails as it would have,
 * while every other test still runs. Any other error is a fault, and
 * fails the run rather than quietly leaving it without one, removing the
 * folder if it was made.
 */
function socketRoot(): string | undefined {
	let folder: string;
	try {
		folder = mkdtempSync(join(SHORT_PARENT, SHORT_PREFIX));
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code ?? "";
		if (REFUSED.has(code)) return undefined;
		if (MISSING.has(code)) {
			process.stderr.write(`no short folder for sockets: /tmp gave ${code}\n`);
			return undefined;
		}
		throw error;
	}
	try {
		nameRun(folder);
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
 *   `STALE_MS` has passed; a live run keeps its folder fresh, so only a
 *   gone run's grows that stale.
 * - A judged pid that lives keeps its folder at any age; a reused pid's
 *   folder then stays until the pid ends or the machine restarts, which
 *   costs a few bytes rather than a live run.
 * - A folder with no run file, or an empty one, as a run killed while
 *   writing it leaves, may be a run's starting now, and stays for
 *   `STARTING_MS`; after that it goes only if empty but for that file,
 *   and one holding anything else is left as it is.
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
			else if (fate === "removed if empty" && emptyButRunFile(folder)) {
				unlinkEmptyRunFile(folder);
				// Fails on anything made inside since, which then stays.
				rmdirSync(folder);
			}
		} catch {
			// Gone, unreadable or not empty: not this sweep's to take.
		}
	}
}

/** Whether `folder` holds nothing, or nothing but its run file. */
function emptyButRunFile(folder: string): boolean {
	return readdirSync(folder).every((name) => name === RUN_FILE);
}

/** Take out `folder`'s run file, if it has one, which its fate found empty. */
function unlinkEmptyRunFile(folder: string): void {
	try {
		unlinkSync(join(folder, RUN_FILE));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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
		record = "";
	}
	if (record === "") return age > STARTING_MS ? "removed if empty" : "kept";
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
