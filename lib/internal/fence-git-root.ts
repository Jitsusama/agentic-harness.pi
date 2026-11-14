/**
 * The git folder a fenced session's own worktree shares with its
 * repository, writable inside while a watcher outside keeps it from
 * being turned against git outside.
 *
 * A worktree's git writes some files at its repository's git folder
 * itself, not in its own folder under `worktrees`: `packed-refs`, which
 * every branch delete rewrites, among them. Git writes each as a lock
 * file renamed over the old, and a rename onto a file bound on its own
 * fails, so the folder itself is bound writable (ISXEG8, 14 November
 * 2026). What makes git run code stays read-only: its settings, hooks,
 * `info`, the submodules' git folders under `modules`, and every other
 * tree's folder under `worktrees`.
 *
 * What a bind can't keep out is a name that isn't there yet. A
 * `commondir` made in that folder sends git outside, the person's
 * prompt included, to read its settings from wherever it names, and a
 * `config.worktree` does the same where the repository's settings turn
 * that file on. Planting one is never legitimate. So before any fenced
 * command may write the folder, a watcher in pi's own process, outside
 * the fence, is armed on it and on the session's own folder. It removes
 * a planted name as soon as it's made, logs a refusal naming each
 * session that could have made it, and stops those sessions' fenced
 * commands. Where the watcher can't be armed, the folder stays
 * read-only. Until a day of use shows no false refusal, this holds only
 * for a session working in a worktree; one in a repository's main
 * checkout keeps its git folder read-only.
 */

import {
	type FSWatcher,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	watch,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { recordRefusal, systemLogger } from "./fence-log.ts";

/**
 * What in the shared git folder stays read-only inside: what makes git
 * run code, and every tree's own folder, the session's own bound back.
 */
export const ROOT_KEPT = [
	"config",
	"config.worktree",
	"hooks",
	"info",
	"modules",
	"worktrees",
] as const;

/**
 * The folders of `ROOT_KEPT` made first where they're missing, so they
 * can be bound read-only: an empty one changes nothing git does, and
 * one made inside would hold hooks, attributes or a submodule's
 * settings for git outside.
 */
const MADE_FIRST = ["hooks", "info", "modules"] as const;

/** Names git never makes in a repository's git folder, which redirect it. */
const NEVER_MADE = ["commondir", "gitdir"] as const;

/** The repository git folder a worktree's own folder lies in, if it does. */
export function sharedGitFolder(own: string | undefined): string | undefined {
	if (!own || basename(dirname(own)) !== "worktrees") return undefined;
	return dirname(dirname(own));
}

/**
 * bubblewrap's arguments for the shared git folder: the folder
 * writable, with what of `ROOT_KEPT` is there read-only over it. They
 * go before the session's own folder is bound back.
 */
export function sharedRootArgs(
	root: string,
	there: (path: string) => boolean,
): string[] {
	return [
		"--bind",
		root,
		root,
		...ROOT_KEPT.map((name) => join(root, name))
			.filter(there)
			.flatMap((path) => ["--ro-bind", path, path]),
	];
}

/** Whether a repository's settings have git read `config.worktree`. */
function readsWorktreeConfig(root: string): boolean {
	try {
		return /^\s*worktreeconfig\s*=\s*(true|yes|on|1)\s*$/im.test(
			readFileSync(join(root, "config"), "utf8"),
		);
	} catch {
		// Settings that can't be read here can't be told safe, so the
		// file counts as read.
		return true;
	}
}

function present(path: string): boolean {
	return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
}

/** What the watcher may do, given so a test can stand in for it. */
export interface RootWatchDeps {
	readonly watch: (
		folder: string,
		heard: (name: string | null) => void,
	) => { close(): void };
	/** Remove what was planted; never refuses. */
	readonly remove: (path: string) => void;
	/** Log a plant's refusal for a session. */
	readonly refused: (session: string) => void;
	/** Stop a session's fenced commands. */
	readonly stop: (session: string) => void;
}

const LIVE: RootWatchDeps = {
	watch: (folder, heard) => {
		const watcher: FSWatcher = watch(
			folder,
			{ persistent: false },
			(_event, name) => heard(typeof name === "string" ? name : null),
		);
		// An error after arming (the folder removed) ends the watch, and
		// with it nothing more is written there to guard.
		watcher.on("error", () => watcher.close());
		return watcher;
	},
	remove: (path) => {
		try {
			rmSync(path, { recursive: true, force: true });
		} catch {
			// What can't be removed is still logged and its sessions stopped,
			// and the next command's check tries again.
		}
	},
	refused: (session) => {
		void recordRefusal(
			{ kind: "plant", tool: "git", sandbox: "fence", session },
			systemLogger(),
		);
	},
	stop: (session) => {
		endFencedCommands(session);
	},
};

/** One armed watch: what it guards in a folder, and who could write it. */
interface Armed {
	readonly guarded: readonly string[];
	readonly sessions: Set<string>;
	watcher: { close(): void } | undefined;
	readonly deps: RootWatchDeps;
}

/** Each folder's armed watch, by the folder. */
const ARMED = new Map<string, Armed>();

/** The sessions whose fenced commands a plant stopped, for this process. */
const STOPPED = new Set<string>();

/** Why a stopped session's fenced commands are refused. */
export const PLANT_STOPPED =
	"A name that sends git outside the fence to settings elsewhere (commondir, gitdir or config.worktree) was made in this session's shared git folder. Nothing legitimate makes one, so this session's fenced commands are stopped for the rest of it and the fence log says so. Tell the person; a fresh session works as before.";

/** Whether a plant stopped `session`'s fenced commands. */
export function plantStopped(session: string | undefined): boolean {
	return session !== undefined && STOPPED.has(session);
}

/**
 * What a watch guards in the shared `root` and in the session's `own`
 * folder: the names git never makes there, and `config.worktree` where
 * the repository's settings have git read it and it isn't there yet
 * (one there already is bound read-only).
 */
export function guardedNames(root: string, own: string): Map<string, string[]> {
	const worktreeConfig = readsWorktreeConfig(root);
	const unmade = (folder: string, name: string) => !present(join(folder, name));
	const config = (folder: string) =>
		worktreeConfig && unmade(folder, "config.worktree")
			? ["config.worktree"]
			: [];
	return new Map([
		[root, [...NEVER_MADE, ...config(root)]],
		[own, config(own)],
	]);
}

function planted(armed: Armed, path: string): void {
	armed.deps.remove(path);
	for (const session of armed.sessions) {
		armed.deps.refused(session);
		STOPPED.add(session);
		armed.deps.stop(session);
	}
}

function sweep(armed: Armed): void {
	for (const path of armed.guarded) if (present(path)) planted(armed, path);
}

/** Arm a watch on `folder` for `names`, once a process, or say it can't. */
function armFolder(
	folder: string,
	names: readonly string[],
	deps: RootWatchDeps,
): Armed | undefined {
	const known = ARMED.get(folder);
	if (known) return known;
	const guarded = names.map((name) => join(folder, name));
	const armed: Armed = {
		guarded,
		sessions: new Set(),
		watcher: undefined,
		deps,
	};
	if (guarded.length === 0) {
		ARMED.set(folder, armed);
		return armed;
	}
	try {
		const watcher = deps.watch(folder, (name) => {
			// A watch that can't name what changed sweeps all it guards.
			if (name === null) sweep(armed);
			else if (names.includes(name) && present(join(folder, name)))
				planted(armed, join(folder, name));
		});
		armed.watcher = watcher;
		ARMED.set(folder, armed);
		return armed;
	} catch {
		return undefined;
	}
}

/**
 * Arm the watch on the shared `root` and the session's `own` folder for
 * `session`, and sweep both for anything planted since. Answers whether
 * both are armed: when they aren't, the root stays read-only. A root
 * that already holds a name git never makes there is never armed.
 */
export function armSharedRoot(
	root: string,
	own: string,
	session: string,
	given: Partial<RootWatchDeps> = {},
): boolean {
	const deps = { ...LIVE, ...given };
	if (NEVER_MADE.some((name) => present(join(root, name))) && !ARMED.has(root))
		return false;
	for (const name of MADE_FIRST) {
		try {
			mkdirSync(join(root, name), { recursive: true, mode: 0o755 });
		} catch {
			return false;
		}
	}
	const armed: Armed[] = [];
	for (const [folder, names] of guardedNames(root, own)) {
		const one = armFolder(folder, names, deps);
		if (!one) return false;
		armed.push(one);
	}
	for (const one of armed) {
		one.sessions.add(session);
		sweep(one);
	}
	return true;
}

/**
 * The shared git folder a fenced command may write for `session`,
 * working in the tree whose own git folder is `own`: one the fence
 * `guards`, once its watch is armed; nothing otherwise, and the folder
 * stays read-only.
 */
export function sharedRootFor(
	own: string | undefined,
	session: string | undefined,
	guards: (root: string) => boolean,
): string | undefined {
	const root = sharedGitFolder(own);
	if (!root || !own || !session || !guards(root)) return undefined;
	return armSharedRoot(root, own, session) ? root : undefined;
}

/**
 * The shell that checks, outside the fence, once a fenced command ends,
 * what the watch guards, and removes and logs anything planted that it
 * missed. It keeps the command's own status.
 */
export function afterCheck(guarded: readonly string[], log: string): string {
	if (guarded.length === 0) return "";
	const quote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;
	const each = guarded
		.map(
			(path) =>
				`if [ -e ${quote(path)} ] || [ -L ${quote(path)} ]; then rm -rf -- ${quote(path)}; ${log}; fi`,
		)
		.join("; ");
	return `__pi_status=$?; ${each}; (exit $__pi_status)`;
}

/** What the watches on `folders` guard, once armed, for the after-check. */
export function guardedIn(folders: readonly string[]): string[] {
	return folders.flatMap((folder) => [...(ARMED.get(folder)?.guarded ?? [])]);
}

/**
 * End `session`'s fenced commands: each bubblewrap this account runs
 * for that session, by its own environment, which takes everything
 * inside with it. Only this account's processes are read, and only
 * bubblewrap's.
 */
export function endFencedCommands(
	session: string,
	proc = "/proc",
	kill: (pid: number) => void = (pid) => process.kill(pid, "SIGTERM"),
): number {
	const uid = process.getuid?.();
	const mark = `PI_SESSION_ID=${session}`;
	let ended = 0;
	let entries: string[];
	try {
		entries = readdirSync(proc);
	} catch {
		return 0;
	}
	for (const entry of entries) {
		if (!/^\d+$/.test(entry)) continue;
		try {
			const status = readFileSync(join(proc, entry, "status"), "utf8");
			const owner = /^Uid:\s+(\d+)/m.exec(status)?.[1];
			if (uid !== undefined && owner !== String(uid)) continue;
			if (readFileSync(join(proc, entry, "comm"), "utf8").trim() !== "bwrap")
				continue;
			const env = readFileSync(join(proc, entry, "environ"), "utf8").split(
				"\0",
			);
			if (!env.includes(mark)) continue;
			kill(Number(entry));
			ended += 1;
		} catch {
			// A process gone between the listing and the read is one fewer
			// to end.
		}
	}
	return ended;
}

/** Forget every armed watch, for a test that arms its own. */
export function disarmAll(): void {
	for (const armed of ARMED.values()) armed.watcher?.close();
	ARMED.clear();
	STOPPED.clear();
}
