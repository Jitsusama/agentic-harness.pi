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
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default function setup(): () => void {
	const previous = process.env.TMPDIR;
	const root = mkdtempSync(join(tmpdir(), "vitest-run-"));
	process.env.TMPDIR = root;
	return () => {
		if (previous === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = previous;
		rmSync(root, { recursive: true, force: true });
	};
}
