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

/** The file in a short folder naming the run that made it. */
const RUN_FILE = "run.pid";

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
	const sockets = socketRoot();
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
 * fails the run rather than quietly leaving it without one.
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
	writeFileSync(join(folder, RUN_FILE), String(process.pid));
	return folder;
}

/**
 * Remove the short folders in `parent` that this account's runs made and
 * that outlived them. One whose run file is missing may be a run's that
 * is starting now, and one whose process lives may be a reused id's;
 * both stay, so a sweep never takes a live run's folder.
 */
export function sweepShortFolders(parent: string): void {
	let names: string[];
	try {
		names = readdirSync(parent);
	} catch {
		return;
	}
	const uid = process.getuid?.();
	for (const name of names) {
		if (!name.startsWith(SHORT_PREFIX)) continue;
		const folder = join(parent, name);
		try {
			const stat = lstatSync(folder);
			if (!stat.isDirectory() || stat.uid !== uid) continue;
			const pid = Number(readFileSync(join(folder, RUN_FILE), "utf8"));
			if (!Number.isInteger(pid) || pid <= 0 || alive(pid)) continue;
			rmSync(folder, { recursive: true, force: true });
		} catch {
			// Gone, unreadable or still starting: another sweep's to take.
		}
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
