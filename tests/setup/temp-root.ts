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

import { mkdtempSync, rmSync } from "node:fs";
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

/**
 * Point TMPDIR at the run's own directory, name a short one for sockets,
 * and remove both at the end, so what a killed worker left in either
 * goes too.
 */
export default function setup(): () => void {
	const previous = process.env.TMPDIR;
	const root = mkdtempSync(
		join(runRootBase(process.platform, tmpdir()), "vitest-run-"),
	);
	process.env.TMPDIR = root;
	const sockets = socketRoot();
	if (sockets !== undefined) process.env[SOCKET_ROOT] = sockets;
	return () => {
		if (previous === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = previous;
		delete process.env[SOCKET_ROOT];
		rmSync(root, { recursive: true, force: true });
		if (sockets !== undefined)
			rmSync(sockets, { recursive: true, force: true });
	};
}

/**
 * The run's short folder, 14 bytes under /tmp, or none where /tmp can't
 * be written, as under a fence granting only TMPDIR: a test needing one
 * then fails as it would have, while every other test still runs.
 */
function socketRoot(): string | undefined {
	try {
		return mkdtempSync("/tmp/vs-");
	} catch {
		return undefined;
	}
}
