/**
 * Following the install: a session that runs a package's install
 * reloads itself when that install moves, at a moment that loses
 * nothing.
 *
 * Sessions used to be told to reload by mail, and mostly did not: the
 * mail told every session that did not own the harness to let it go,
 * and an idle one never got a turn to read it at all. Whether code
 * on disk is newer than the code running is not a judgement for a
 * model to make, though. The harness can see its own install move, so
 * it reloads itself, and the model is told afterwards what came in.
 *
 * The moment matters more than the move. A reload pulls the tools from
 * under a run that is streaming, so it waits for the run to end, and
 * for the install that follows the move to finish, since `git merge`
 * lands before `pnpm install` does, and pnpm takes the packages away
 * while it reinstalls them, lockfile changed or not.
 * It does not wait for background jobs: a reload hands them, still
 * running, to the runtime it starts (extensions/job-workflow/carry.ts). A session that
 * runs a tree rather than the install is being tested on purpose and
 * is never moved.
 *
 * It does not wait for the cache. A reload that changes tools or
 * prompt sections keeps it: pi sends tool changes inline and section
 * changes after the conversation. Measured with `pi -p` on 22
 * October, a tool removed between turns left the next request
 * reading 76,431 cached tokens and writing 127. Those changes rewrote
 * the whole cache only while a prompt hook forced the system prompt,
 * which agentic-harness.pi#641 ended.
 */

import { execFile } from "node:child_process";
import {
	existsSync,
	type FSWatcher,
	lstatSync,
	statSync,
	watch,
} from "node:fs";
import { basename, dirname, join } from "node:path";

/** How long a checkout must be still before its HEAD is read. */
export const QUIET_MS = 3_000;

/** How many changes are named when a reload says what came in. */
const MOST_NAMED = 8;

/** The environment variable that turns following off. */
export const FOLLOW_ENV = "PI_FOLLOW_INSTALL";

/** When a waiting reload should happen, given where the session stands. */
export type Moment = "now" | "after-run" | "wait" | "never";

/** Where a session stands when its install has moved. */
export interface Standing {
	/** It runs a tree in place of the install, on purpose. */
	readonly swapped: boolean;
	/** No run is under way. */
	readonly idle: boolean;
	/** Every moved install has the dependencies its lockfile names. */
	readonly ready: boolean;
}

/** When to reload a session standing like this. */
export function whenToReload(at: Standing): Moment {
	if (at.swapped) return "never";
	if (!at.ready) return "wait";
	return at.idle ? "now" : "after-run";
}

/**
 * How long after a move the install is taken as done when nothing has
 * installed since, so a checkout moved by hand without an install still
 * reloads. pi's own update installs within seconds of moving it.
 */
export const INSTALL_GRACE_MS = 5 * 60_000;

/**
 * Whether a checkout's dependencies are installed for where it now
 * stands. pnpm writes `node_modules/.modules.yaml` last, so an install
 * has finished once that is newer than the lockfile and, when the move
 * is known (`movedAt`), than the move. pi installs after every update,
 * even one that leaves the lockfile as it was, and pnpm takes the
 * packages away and back while it does: on 26 October, sessions that
 * reloaded the moment the lockfile looked current found 15 of them
 * missing. With no `.modules.yaml` an install is under way, or never
 * finished. A checkout with no lockfile has nothing to wait for.
 */
export function dependenciesReady(
	root: string,
	movedAt?: number,
	now = Date.now(),
): boolean {
	let lock: number;
	try {
		lock = statSync(join(root, "pnpm-lock.yaml")).mtimeMs;
	} catch {
		// No lockfile: nothing is installed for it, so nothing to wait for.
		return true;
	}
	let installed: number;
	try {
		installed = statSync(join(root, "node_modules", ".modules.yaml")).mtimeMs;
	} catch {
		// No record of a finished install: one is under way or failed.
		return false;
	}
	if (installed < lock) return false;
	if (movedAt === undefined || installed >= movedAt) return true;
	return now - movedAt >= INSTALL_GRACE_MS;
}

function git(root: string, args: readonly string[]): Promise<string> {
	return new Promise((resolve) => {
		execFile(
			"git",
			["-C", root, ...args],
			{ timeout: 10_000 },
			(error, stdout) => resolve(error ? "" : stdout),
		);
	});
}

/** A checkout's HEAD now, or nothing when git cannot say. */
export async function headOf(root: string): Promise<string | undefined> {
	return (await git(root, ["rev-parse", "HEAD"])).trim() || undefined;
}

/**
 * What came in between two commits, by the names people know them by:
 * a GitHub merge commit says the pull request's number and title, and
 * anything else its subject.
 */
export async function cameIn(
	root: string,
	from: string,
	to: string,
): Promise<string[]> {
	const log = await git(root, [
		"log",
		"--first-parent",
		`-n${MOST_NAMED}`,
		"--format=%s%x00%b%x1e",
		`${from}..${to}`,
	]);
	return log
		.split("\x1e")
		.map((record) => record.trim())
		.filter(Boolean)
		.map((record) => {
			const [subject = "", body = ""] = record.split("\0");
			const merged = subject.match(/^Merge pull request (#\d+)/);
			const title = body.trim().split("\n")[0]?.trim();
			return merged && title ? `${merged[1]} ${title}` : subject;
		});
}

/** A checkout that moved, and from where to where. */
export interface Moved {
	readonly root: string;
	readonly from: string;
	readonly to: string;
	/**
	 * When it moved, as epoch milliseconds: the moment the checkout went
	 * still before its HEAD was read. Unknown for a move made before this
	 * runtime started.
	 */
	readonly at?: number;
}

/** Stops watching. */
export type Unwatch = () => void;

/** Whether a package root is a link, as an install of whole releases is. */
function isLink(root: string): boolean {
	try {
		return lstatSync(root).isSymbolicLink();
	} catch {
		// A root that cannot be read is no link to follow.
		return false;
	}
}

// The HEAD each checkout was at when this code was loaded from it. Kept at
// module level, which is exactly as long-lived as the code: pi reuses its
// cached extension modules when a rollover or a resume replaces the
// session, and loads them afresh only on a reload. So a runtime that
// starts after a replacement can still tell that the install moved past
// the code it runs, though git's HEAD already reads as the new commit.
const loadedAt = new Map<string, string>();

/**
 * Watch each checkout's git directory and say when its HEAD moves.
 * A merge or a pull writes several files in a burst, so HEAD is read
 * once the checkout has been still for `quietMs`, and only a change
 * from the last HEAD seen is said. Nothing is polled.
 */
export async function watchHeads(
	roots: readonly string[],
	onMoved: (moved: Moved) => void,
	quietMs = QUIET_MS,
): Promise<Unwatch> {
	const watchers: FSWatcher[] = [];
	const timers = new Set<NodeJS.Timeout>();
	const already: Moved[] = [];
	let stopped = false;
	for (const root of roots) {
		const dir = join(root, ".git");
		// A worktree's .git is a file, and a copy without git has none:
		// neither is an install that moves by merging.
		if (!existsSync(join(dir, "HEAD"))) continue;
		let seen = await headOf(root);
		if (seen === undefined) continue;
		const loaded = loadedAt.get(root);
		if (loaded === undefined) loadedAt.set(root, seen);
		else if (loaded !== seen) already.push({ root, from: loaded, to: seen });
		let timer: NodeJS.Timeout | undefined;
		const settle = () => {
			if (timer) {
				clearTimeout(timer);
				timers.delete(timer);
			}
			timer = setTimeout(async () => {
				if (timer) timers.delete(timer);
				const now = await headOf(root);
				if (stopped || now === undefined || now === seen) return;
				const from = seen;
				seen = now;
				const at = Date.now() - quietMs;
				if (from !== undefined) onMoved({ root, from, to: now, at });
			}, quietMs);
			timer.unref?.();
			timers.add(timer);
		};
		// Only the git directory, not refs/heads: moving the checked-out
		// branch takes HEAD.lock there however it is moved (commit, merge,
		// pull, even `git update-ref`), so a second watch adds nothing.
		// An install named by a link moves by the link being renamed onto
		// another release, in the folder that holds it, and the git
		// directory watched through it is the old release's, which never
		// moves again; so that folder is watched, for the link alone.
		const link = isLink(root);
		try {
			const watcher = link
				? watch(dirname(root), { persistent: false }, (_kind, name) => {
						if (name === null || String(name) === basename(root)) settle();
					})
				: watch(dir, { persistent: false }, settle);
			watcher.on("error", () => watcher.close());
			watchers.push(watcher);
		} catch {
			// A directory that cannot be watched is followed no further.
		}
	}
	// Moves made before this runtime started, under code that is still
	// loaded: said once the watch is in place, as a move seen now would be.
	for (const moved of already) onMoved(moved);
	return () => {
		stopped = true;
		for (const watcher of watchers) watcher.close();
		for (const timer of timers) clearTimeout(timer);
		timers.clear();
	};
}
