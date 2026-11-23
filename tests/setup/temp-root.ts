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

/** Point TMPDIR at the run's own directory, and remove it at the end. */
export default function setup(): () => void {
	const previous = process.env.TMPDIR;
	const root = mkdtempSync(
		join(runRootBase(process.platform, tmpdir()), "vitest-run-"),
	);
	process.env.TMPDIR = root;
	return () => {
		if (previous === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = previous;
		rmSync(root, { recursive: true, force: true });
	};
}
