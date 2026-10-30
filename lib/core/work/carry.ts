/**
 * Carrying a tree's work home from a machine that is leaving.
 *
 * A machine lent for a while, such as a cloud sandbox, is destroyed with
 * everything on it, and it may not be allowed to push where the work
 * belongs. Mycelium's share carries a quest's folders to its other
 * machines, but a clone crosses only as its origin and branch, so commits
 * that were never pushed would stay behind. So the commits a tree holds
 * that no remote has go into a git bundle, one file, in a folder the share
 * carries. At home the tree fetches the branch from the bundle.
 *
 * A carry leaves two kinds of note beside what it carries, in the folder
 * it is given:
 *
 * - `<name>.json` beside `<name>.bundle`, for a tree: a {@link CarriedTree},
 *   which taking the bundle up at home reads.
 * - `sessions/<id>.json` beside the session's file, for a session: a
 *   {@link CarriedSession}, which Restore reads.
 *
 * Files not committed are left behind and named, never a reason to carry
 * nothing: on a machine with minutes left, one stray log refusing the
 * whole carry would lose every commit with it.
 */

import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Exec } from "../exec/index.ts";

/** A commit a bundle needs before it can be fetched from. */
export interface Needed {
	/** The commit. */
	commit: string;
	/** A remote branch on the leaving machine that held it, such as `origin/main`. */
	on?: string;
}

/** What a tree's carry left, read by whoever takes it up at home. */
export interface CarriedTree {
	/** The branch the commits belong on. */
	branch: string;
	/** The commit the branch stood at. */
	head: string;
	/** How many of its commits no remote has. */
	commits: number;
	/**
	 * What the bundle leaves out because a remote held it, which home must
	 * hold first: fetching the remote branch each was on brings it.
	 */
	needs: Needed[];
	/** Where the tree's origin is, so home knows which tree takes it. */
	origin?: string;
	/** The bundle's file name, beside this note. */
	bundle: string;
	/** The files not committed, which stayed on the leaving machine. */
	left: string[];
}

/** What carrying a tree did, or why it did nothing. */
export type CarryOutcome =
	| { kind: "carried"; carried: CarriedTree; note: string }
	| { kind: "nothing"; branch: string; left: string[] }
	| { kind: "refused"; reason: string };

/** Ask git one thing in the tree, or undefined when it says nothing. */
async function ask(
	exec: Exec,
	treePath: string,
	args: readonly string[],
): Promise<string | undefined> {
	const result = await exec("git", ["-C", treePath, ...args]);
	if (result.code !== 0) return undefined;
	const said = result.stdout.trim();
	return said === "" ? undefined : said;
}

/**
 * The paths `git status --porcelain -z` names, as written on disk: each
 * entry is two status letters, a space and the path, and a rename or a
 * copy is followed by the path it came from, which is passed over.
 */
function leftOut(status: string): string[] {
	const entries = status.split("\0");
	const paths: string[] = [];
	for (let at = 0; at < entries.length; at++) {
		const entry = entries[at] ?? "";
		if (entry === "") continue;
		paths.push(entry.slice(3));
		if (/^[RC]/.test(entry)) at++;
	}
	return paths;
}

/** What `--not --remotes` leaves a bundle needing, with where each was. */
async function needed(exec: Exec, treePath: string): Promise<Needed[]> {
	const boundary = await ask(exec, treePath, [
		"rev-list",
		"--boundary",
		"HEAD",
		"--not",
		"--remotes",
	]);
	const commits = (boundary ?? "")
		.split("\n")
		.filter((line) => line.startsWith("-"))
		.map((line) => line.slice(1));
	return Promise.all(
		commits.map(async (commit) => {
			// A remote's HEAD names no branch to fetch, so it is passed over.
			const on = (
				await ask(exec, treePath, [
					"branch",
					"--remotes",
					"--contains",
					commit,
					"--format=%(refname)",
				])
			)
				?.split("\n")
				.filter((ref) => !ref.endsWith("/HEAD"))
				.map((ref) => ref.replace(/^refs\/remotes\//, ""))[0];
			return on === undefined ? { commit } : { commit, on };
		}),
	);
}

/**
 * Bundles the commits in the tree at `treePath` that no remote has into
 * `into`, as `<name>.bundle` beside a note `<name>.json`.
 *
 * The bundle leaves out what any remote holds, so it stays small, and
 * the note says which commits that leaves it needing.
 */
export async function carryTree(
	exec: Exec,
	treePath: string,
	into: string,
	name: string,
): Promise<CarryOutcome> {
	const branch = await ask(exec, treePath, [
		"rev-parse",
		"--abbrev-ref",
		"HEAD",
	]);
	if (branch === undefined || branch === "HEAD") {
		return {
			kind: "refused",
			reason:
				"This tree is not on a branch, so its commits would have nowhere to go at home. Make one with a branch action first.",
		};
	}
	const status = await exec("git", [
		"-C",
		treePath,
		"status",
		"--porcelain",
		"-z",
		"--untracked-files=all",
	]);
	if (status.code !== 0) {
		return {
			kind: "refused",
			reason: `git couldn't say what this tree holds: ${status.stderr.trim()}`,
		};
	}
	const left = leftOut(status.stdout);
	const counted = await ask(exec, treePath, [
		"rev-list",
		"--count",
		"HEAD",
		"--not",
		"--remotes",
	]);
	const commits = Number(counted ?? "0");
	if (commits === 0) return { kind: "nothing", branch, left };
	const head = await ask(exec, treePath, ["rev-parse", "HEAD"]);
	if (head === undefined) {
		return { kind: "refused", reason: "git couldn't say what HEAD is." };
	}
	mkdirSync(into, { recursive: true });
	const bundle = `${name}.bundle`;
	const bundled = await exec("git", [
		"-C",
		treePath,
		"bundle",
		"create",
		join(into, bundle),
		`refs/heads/${branch}`,
		"--not",
		"--remotes",
	]);
	if (bundled.code !== 0) {
		return {
			kind: "refused",
			reason: `git couldn't bundle ${branch}: ${bundled.stderr.trim()}`,
		};
	}
	const origin = await ask(exec, treePath, [
		"config",
		"--get",
		"remote.origin.url",
	]);
	const carried: CarriedTree = {
		branch,
		head,
		commits,
		needs: await needed(exec, treePath),
		...(origin === undefined ? {} : { origin }),
		bundle,
		left,
	};
	const note = join(into, `${name}.json`);
	writeFileSync(note, `${JSON.stringify(carried, null, 2)}\n`);
	return { kind: "carried", carried, note };
}

/** What Restore needs of a session carried home. */
export interface CarriedSession {
	/** The session's id. */
	id: string;
	/** The folder it ran in, on the machine it left. */
	cwd: string;
	/** The quest it had loaded, if any. */
	quest?: string;
	/** Its window's title, if it had one. */
	title?: string;
	/** The session file's name, beside this note. */
	file: string;
}

/**
 * Copies the session file at `file` into `into`, beside a note of what
 * Restore needs to reopen it, returning the note's path.
 */
export function carrySession(
	file: string,
	into: string,
	session: Omit<CarriedSession, "file">,
): string {
	mkdirSync(into, { recursive: true });
	const name = basename(file);
	copyFileSync(file, join(into, name));
	const note = join(into, `${session.id}.json`);
	const carried: CarriedSession = { ...session, file: name };
	writeFileSync(note, `${JSON.stringify(carried, null, 2)}\n`);
	return note;
}
