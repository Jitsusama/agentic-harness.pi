/**
 * A fetch of World's main answered by one that has just made it.
 *
 * Every World tree is a worktree of one repository, `~/world/git`, so a
 * fetch of origin's main from any of them leaves the same `origin/main`,
 * and every commit it names, for all of them. A second fetch of main
 * still walks: from 4 to 5 November one started within two minutes of
 * another's end ran a median 46 s and held 5.9 GiB, against 108 s for
 * the rest, and four of them waited up to 75 minutes in line behind one
 * already running (80ECO2).
 *
 * So a fetch of main waits for one running rather than beside it (see
 * queue.ts's `walkWaits`), and once a fetch of main has moved
 * `origin/main`, every fetch of main waiting or asked in the next
 * {@link ANSWERED_FOR_MS} gets its turn at once, past the walks, with
 * fetched-git.mjs first on its shell's PATH as `git`. That answers each fetch
 * of origin's main in World from the ref the other left, writing
 * FETCH_HEAD as git does, and runs the real git for everything else.
 * A fetch answered so sees main as it stood up to a minute before, as
 * it would had it run a minute earlier.
 *
 * The fetch that answers is known to have moved `origin/main` by its
 * own shell, which reads the ref as its turn begins and as it ends:
 * a fetch's exit says little, since most are piped into `tail` or
 * `grep`, and World's refs are a reftable no file read can follow.
 */

import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeWhole } from "../write-whole.ts";
import type { Outcome } from "./outcome.ts";
import type { Job } from "./queue.ts";

/**
 * How long after a fetch of main moved `origin/main` a fetch of main
 * asked is answered by it.
 */
export const ANSWERED_FOR_MS = 60_000;

/** The folder in the queue's that holds the `git` that runs fetched-git.mjs. */
export const FETCHED_FOLDER = "fetched";

/** The ref a fetch of origin's main moves, read before and after. */
const MAIN_REF = "refs/remotes/origin/main";

/** World's one repository, which every World tree is a worktree of. */
export function worldGit(home: string = homedir()): string {
	return join(home, "world", "git");
}

/**
 * The fetch of main that answers fetches of main now: the last to end
 * that moved `origin/main`, itself unanswered, within
 * {@link ANSWERED_FOR_MS} of `now`.
 */
export function answeringFetch(
	outcomes: readonly Outcome[],
	now: number,
): Outcome | undefined {
	for (let at = outcomes.length - 1; at >= 0; at -= 1) {
		const outcome = outcomes[at];
		if (now - Date.parse(outcome.ended) > ANSWERED_FOR_MS) continue;
		if (outcome.walk === "main-fetch" && outcome.movedMain) return outcome;
	}
	return undefined;
}

/** The jobs waiting that a fetch of main just made answers. */
export function answerable(jobs: readonly Job[]): Job[] {
	return jobs.filter(
		(job) =>
			job.started === undefined &&
			!job.planning &&
			job.kind === "world-walk" &&
			job.walk === "main-fetch",
	);
}

/**
 * Whether a fetch moved `origin/main`, by what its shell read of the
 * ref as its turn began and as it ended: two readings that differ, the
 * last a commit.
 */
export function movedMain(before: string, after: string): boolean {
	const read = after.trim();
	return /^[0-9a-f]{40,64}$/.test(read) && read !== before.trim();
}

/**
 * The shell line that reads `origin/main` in World's repository into
 * `file`, quietly, which leaves `$?` as it found it.
 */
export function readsMain(gitDir: string, file: string): string {
	return `{ timeout 10 git --git-dir='${gitDir}' rev-parse -q --verify ${MAIN_REF} > ${file}; } 2>/dev/null || :`;
}

/**
 * The `git` an answered shell runs: this node running fetched-git.mjs,
 * told its own folder and World's repository. Nothing for a path that
 * can't be quoted plainly.
 */
export function fetchedGit(
	world: string,
	node: string = process.execPath,
	script: string = fileURLToPath(new URL("./fetched-git.mjs", import.meta.url)),
): string | undefined {
	if ([world, node, script].some((path) => path.includes("'"))) {
		return undefined;
	}
	return `#!/bin/sh\nexec '${node}' '${script}' "\${0%/*}" '${world}' "$@"\n`;
}

/**
 * Puts {@link fetchedGit} in the queue's folder as `fetched/git`,
 * runnable, unless it is there as it is: its folder is what an answered
 * shell puts first on its PATH. Whether it is there to run.
 */
export function placeFetchedGit(dir: string, world: string): boolean {
	const wrapper = fetchedGit(world);
	if (wrapper === undefined) return false;
	const folder = join(dir, FETCHED_FOLDER);
	const file = join(folder, "git");
	try {
		if (readFileSync(file, "utf8") === wrapper) return true;
	} catch {
		// Not placed yet: placed below.
	}
	try {
		mkdirSync(folder, { recursive: true });
		writeWhole(file, wrapper);
		chmodSync(file, 0o755);
		return true;
	} catch {
		// Unwritable: its fetches take their own turns instead.
		return false;
	}
}
