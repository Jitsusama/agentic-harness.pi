/**
 * Killing every process one bash call left, by the mark its environment
 * carries, whatever group or session each moved to. shell-workflow's
 * stop does it in the pi that started the call (its reap.ts says why),
 * and job-workflow's in the one a move carried the call to. Linux only:
 * elsewhere there is no /proc to read.
 *
 * A process moved out on purpose is spared: one whose cgroup lies outside
 * the reaper's own and outside the slice `JOBS_CGROUP` puts work in, as
 * a tunnel `systemd-run --user --scope` started does (WM4KSZ's, killed
 * at two host restarts on 13 November). Everything a call started stays
 * in one of the two unless it is moved, so `setsid`, `nohup`, the jobs
 * sorter's scopes and `jobs-broker run`'s still die with the call. A
 * cgroup that can't be read is never a reason to spare.
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
	/** Where pi puts its work, as `JOBS_CGROUP` names it; that setting by default. */
	jobs?: string | undefined;
	kill?: (pid: number) => void;
}

/** The cgroup a `/proc/<pid>/cgroup` text names on the unified hierarchy. */
export function unifiedCgroup(text: string): string | undefined {
	const line = text.split("\n").find((entry) => entry.startsWith("0::"));
	const path = line?.slice(3).trim();
	return path ? path : undefined;
}

/**
 * Whether a marked process was moved out on purpose: its cgroup is
 * outside the reaper's (`own`) and outside the slice holding `jobs`,
 * under the user manager above the reaper. Without a `jobs` or a user
 * manager, only the reaper's own cgroup counts as where work runs.
 */
export function movedOut(
	cgroup: string | undefined,
	own: string | undefined,
	jobs: string | undefined,
): boolean {
	if (cgroup === undefined || own === undefined) return false;
	if (within(cgroup, own)) return false;
	const slice = workSlice(own, jobs);
	return slice === undefined || !within(cgroup, slice);
}

/** The slice `jobs` sits in, under the user manager above `own`. */
function workSlice(own: string, jobs: string | undefined): string | undefined {
	const top = jobs?.trim().split("/")[0];
	if (!top || top === ".." || top === ".") return undefined;
	const parts = own.split("/");
	const manager = parts.findIndex(
		(part) => part.startsWith("user@") && part.endsWith(".service"),
	);
	return manager < 0
		? undefined
		: [...parts.slice(0, manager + 1), top].join("/");
}

/** Whether cgroup `path` is `folder` or below it. */
function within(path: string, folder: string): boolean {
	return folder === "/" || path === folder || path.startsWith(`${folder}/`);
}

/** A process's cgroup under `procRoot`, or nothing once it can't be read. */
function cgroupIn(procRoot: string, pid: number | string): string | undefined {
	try {
		return unifiedCgroup(
			readFileSync(join(procRoot, String(pid), "cgroup"), "utf8"),
		);
	} catch {
		// Gone, or not ours to read: never a reason to spare it.
		return undefined;
	}
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
	const jobs = "jobs" in options ? options.jobs : process.env.JOBS_CGROUP;
	const own = cgroupIn(procRoot, self);
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
			if (movedOut(cgroupIn(procRoot, name), own, jobs)) continue;
			kill(pid);
			killed.add(pid);
			found++;
		}
		if (found === 0) return;
	}
}
