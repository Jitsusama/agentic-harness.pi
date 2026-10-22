/**
 * Puts each process pi starts into the machine's cgroup for work.
 *
 * pi is something a person works in; the builds, tests and subagents it
 * starts are work. On a Linux machine that keeps an idle cgroup for work,
 * named by `JOBS_CGROUP` as a path under the account's own systemd user
 * manager (`jobs.slice/jobs.service`, say), each child is written into
 * that cgroup the moment it is spawned, so whatever it starts afterwards
 * is born there. pi itself stays where it is, at the priority of
 * everything else the person uses.
 *
 * Every spawn goes through `ChildProcess.prototype.spawn`, whichever
 * extension or library makes it, so wrapping that once a process covers
 * them all. A synchronous spawn does not, which is right: pi blocks on
 * one, as it does when it hands the terminal to an editor.
 *
 * The write lands just after the child starts, and a shell can fork
 * before then: in 200 tries, 31 shells had already run their first
 * command. So the bash tool's shell also moves itself, with
 * {@link shellMovesItself}, before it runs anything.
 */

import { ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const CGROUPS = "/sys/fs/cgroup";

/**
 * Where to write a child's pid, from this process's /proc/self/cgroup and
 * the `JOBS_CGROUP` setting, or nothing when either says there is nowhere:
 * no setting, an absolute or climbing one, or no user manager above us.
 */
export function jobsProcs(
	ownCgroup: string,
	jobs: string | undefined,
): string | undefined {
	const relative = jobs?.trim();
	if (!relative || relative.startsWith("/")) return undefined;
	if (relative.split("/").includes("..")) return undefined;
	const line = ownCgroup.split("\n").find((entry) => entry.startsWith("0::"));
	if (!line) return undefined;
	const parts = line.slice(3).split("/").filter(Boolean);
	const manager = parts.findIndex(
		(part) => part.startsWith("user@") && part.endsWith(".service"),
	);
	if (manager < 0) return undefined;
	return join(
		CGROUPS,
		...parts.slice(0, manager + 1),
		relative,
		"cgroup.procs",
	);
}

/** What {@link placeChildren} writes with, so a test can watch it. */
export type Write = (path: string, pid: number) => void;

const writePid: Write = (path, pid) => writeFileSync(path, `${pid}\n`);

interface Placement {
	path: string;
	write: Write;
	/** Set once the cgroup refuses a write, rather than missing it. */
	broken: boolean;
}

/**
 * Failures that pass: a child that left before it could move, and a
 * cgroup that is gone for the moment, as jobs is while systemd starts it
 * again after systemd-oomd ends it. That child stays where pi is.
 */
const PASSING = new Set(["ESRCH", "ENOENT", "ENODEV"]);

const PLACEMENT = Symbol.for("agentic-harness.priority.placement");
const ORIGINAL = Symbol.for("agentic-harness.priority.original-spawn");

/** Node's own spawn, which its public types leave out. */
type Spawn = (this: ChildProcess, ...args: unknown[]) => unknown;

interface Prototype {
	spawn: Spawn;
	[PLACEMENT]?: Placement;
	[ORIGINAL]?: Spawn;
}

const prototypeOf = () => ChildProcess.prototype as unknown as Prototype;

/** Where children are being written, while the cgroup still takes them. */
export function placementTarget(): string | undefined {
	const placement = prototypeOf()[PLACEMENT];
	return placement && !placement.broken ? placement.path : undefined;
}

/**
 * A line a shell runs first to move itself into `path`, so nothing it
 * starts is born outside. It fails silently and leaves `$?` at 0, and
 * there is none for a path that can't be quoted plainly.
 */
export function shellMovesItself(path: string): string | undefined {
	if (path.includes("'")) return undefined;
	return `printf '%s\\n' "$$" 2>/dev/null > '${path}' || :`;
}

/** `command`, moving its shell into jobs first while children go there. */
export function placedCommand(command: string): string {
	const target = placementTarget();
	const move = target ? shellMovesItself(target) : undefined;
	return move ? `${move}\n${command}` : command;
}

/**
 * Writes every child spawned from now on into `path`. Calling it again
 * replaces the target rather than wrapping twice, since an extension
 * loads again at every reload. The answer undoes it.
 */
export function placeChildren(
	path: string,
	write: Write = writePid,
): () => void {
	const prototype = prototypeOf();
	prototype[PLACEMENT] = { path, write, broken: false };
	if (!prototype[ORIGINAL]) {
		const original = prototype.spawn;
		prototype[ORIGINAL] = original;
		prototype.spawn = function spawnIntoJobs(this: ChildProcess, ...args) {
			const result = original.apply(this, args);
			const placement = prototypeOf()[PLACEMENT];
			if (placement && !placement.broken && this.pid !== undefined) {
				try {
					placement.write(placement.path, this.pid);
				} catch (error) {
					const code = (error as NodeJS.ErrnoException).code;
					if (!code || !PASSING.has(code)) {
						placement.broken = true;
					}
				}
			}
			return result;
		};
	}
	return () => {
		const original = prototype[ORIGINAL];
		if (original) prototype.spawn = original;
		delete prototype[ORIGINAL];
		delete prototype[PLACEMENT];
	};
}
