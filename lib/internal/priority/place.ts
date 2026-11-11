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
 *
 * The write is made off pi's thread. Moving a process between cgroups
 * waits out an RCU grace period, 5 to 7 ms a move on optimus (11
 * November), and pi's thread paid it on every spawn, between keys.
 */

import { ChildProcess } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { queuedCommand } from "./turn.ts";

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

/**
 * What {@link placeChildren} writes with, so a test can watch it. It may
 * throw, or answer a promise that refuses, when the pid can't be written.
 */
export type Write = (path: string, pid: number) => void | Promise<void>;

const writePid: Write = (path, pid) => writeFile(path, `${pid}\n`);

interface Placement {
	path: string;
	/**
	 * Never throws and answers nothing, so a spawn wrapper an earlier load
	 * left on the prototype, which calls this and drops its answer, has no
	 * refusal to leave unhandled ({@link settling}).
	 */
	write: (path: string, pid: number) => void;
	/** Set once the cgroup refuses a write, rather than missing it. */
	broken: boolean;
}

/**
 * Failures that pass: a child that left before it could move, and a
 * cgroup that is gone for the moment, as jobs is while systemd starts it
 * again after systemd-oomd ends it. That child stays where pi is.
 */
const PASSING = new Set(["ESRCH", "ENOENT", "ENODEV"]);

/** Gives up on a placement whose cgroup refused a write, rather than missed it. */
function refused(placement: Placement, error: unknown): void {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	if (!code || !PASSING.has(code)) placement.broken = true;
}

/**
 * `write`, with its refusal handled where it happens. Spawn is wrapped
 * once per process and the wrapper outlives a reload, so the wrapper an
 * older load installed calls this placement's write. One that dropped an
 * asynchronous write's answer left ESRCH unhandled, and that ended every
 * pi that reloaded onto it.
 */
function settling(placement: Placement, write: Write): Placement["write"] {
	return (path, pid) => {
		try {
			const written = write(path, pid);
			if (written instanceof Promise) {
				written.catch((error: unknown) => refused(placement, error));
			}
		} catch (error) {
			refused(placement, error);
		}
	};
}

const PLACEMENT = Symbol.for("agentic-harness.priority.placement");
const ORIGINAL = Symbol.for("agentic-harness.priority.original-spawn");
/** How many {@link withPi} calls are under way, on the prototype every copy shares. */
const STAYING = Symbol.for("agentic-harness.priority.staying");

/** Node's own spawn, which its public types leave out. */
type Spawn = (this: ChildProcess, ...args: unknown[]) => unknown;

interface Prototype {
	spawn: Spawn;
	[PLACEMENT]?: Placement;
	[ORIGINAL]?: Spawn;
	[STAYING]?: number;
}

const prototypeOf = () => ChildProcess.prototype as unknown as Prototype;

/**
 * Runs `spawning`, leaving whatever it spawns where pi is rather than in
 * jobs. For a helper pi keeps for its own screen, as the status line's
 * git engine is: placed in jobs, it starved behind the builds there and
 * the footer lagged whenever the machine was busy. Or for what must stay
 * in its unit, as a host's systemd-notify does, since systemd credits a
 * notify to the cgroup its sender is in. Only what is spawned
 * synchronously inside counts, since spawn itself is synchronous.
 */
export function withPi<T>(spawning: () => T): T {
	const prototype = prototypeOf();
	prototype[STAYING] = (prototype[STAYING] ?? 0) + 1;
	try {
		return spawning();
	} finally {
		prototype[STAYING] = (prototype[STAYING] ?? 1) - 1;
	}
}

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

/**
 * `command`, run in `cwd`, moving its shell into jobs first while
 * children go there, and waiting for its turn in the machine's queue
 * when it is heavy work. `wrap` changes how the command runs once its
 * turn comes ({@link queuedCommand}).
 */
export function placedCommand(
	command: string,
	cwd?: string,
	wrap?: (run: string) => string,
): string {
	const target = placementTarget();
	const move = target ? shellMovesItself(target) : undefined;
	const queued = queuedCommand(command, cwd, wrap);
	return move ? `${move}\n${queued}` : queued;
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
	const placement: Placement = { path, write: () => {}, broken: false };
	placement.write = settling(placement, write);
	prototype[PLACEMENT] = placement;
	if (!prototype[ORIGINAL]) {
		const original = prototype.spawn;
		prototype[ORIGINAL] = original;
		prototype.spawn = function spawnIntoJobs(this: ChildProcess, ...args) {
			const result = original.apply(this, args);
			const { [PLACEMENT]: placement, [STAYING]: staying } = prototypeOf();
			if (
				placement &&
				!placement.broken &&
				!staying &&
				this.pid !== undefined
			) {
				placement.write(placement.path, this.pid);
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
