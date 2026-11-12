/**
 * Killing every process one bash call left, by the mark its environment
 * carries, whatever group or session each moved to. shell-workflow's
 * stop does it in the pi that started the call (its reap.ts says why),
 * and job-workflow's in the one a move carried the call to. Linux only:
 * elsewhere there is no /proc to read.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The variable each command's environment carries its mark in. */
export const CALL_VARIABLE = "PI_BASH_CALL";

/** Where to look and how to kill, for tests to stand in for. */
export interface ReapOptions {
	procRoot?: string;
	/** The process doing the reaping, which is never killed. */
	self?: number;
	kill?: (pid: number) => void;
}

/** How often to look again, for what forked while the last pass killed. */
const PASSES = 3;

/** Kill every process whose environment carries `mark`. */
export function reap(mark: string, options: ReapOptions = {}): void {
	const procRoot = options.procRoot ?? "/proc";
	const self = options.self ?? process.pid;
	const kill =
		options.kill ??
		((pid: number) => {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Gone already, or never ours to kill.
			}
		});
	const marked = `${CALL_VARIABLE}=${mark}`;
	const killed = new Set<number>();
	for (let pass = 0; pass < PASSES; pass++) {
		let pids: string[];
		try {
			pids = readdirSync(procRoot);
		} catch {
			return;
		}
		let found = 0;
		for (const name of pids) {
			const pid = Number(name);
			if (!Number.isInteger(pid) || pid === self || killed.has(pid)) continue;
			let environ: string;
			try {
				environ = readFileSync(join(procRoot, name, "environ"), "latin1");
			} catch {
				// Gone, or somebody else's.
				continue;
			}
			if (!environ.split("\0").includes(marked)) continue;
			kill(pid);
			killed.add(pid);
			found++;
		}
		if (found === 0) return;
	}
}
