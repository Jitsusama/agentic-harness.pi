/**
 * A repository already on this machine with a carried tree's origin,
 * for arriving to clone from, hardlinking its objects, rather than taking
 * every object from the origin again.
 *
 * World's trees on a Mac stand as `~/world/trees/<name>/src`, worktrees
 * of `~/world/git`, and a carried World tree cloned from Delta alone
 * received nothing in forty minutes on 23 November while its sibling
 * trees already held nearly every object. So the twin is looked for beside where the
 * tree goes: among the folders in its parent, its grandparent and the
 * folder above that, and in each one's own folder of the tree's name.
 * Only a repository that is neither shallow nor partial, and borrows no
 * objects from another, is taken, since a clone of one would still lack
 * what it left out.
 */

import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Exec } from "../../core/exec/index.ts";
import { guardsGitFolder } from "../fence/fence.ts";
import { real } from "../sandbox/tree-git.ts";

/** How many folders above the tree's own are looked through. */
const LEVELS = 3;

/**
 * What names a clone an arrival makes beside a tree's path, before it is
 * renamed into place: never a twin, since it may be half made, or left
 * by an arrival that was killed.
 */
export const CLONING = ".cloning-";

/** How many folders in any one place are looked at, at most. */
const MOST_BESIDE = 64;

/**
 * The git common folder of a repository here whose origin is `origin`,
 * found beside `path`, that `take` takes; or nothing.
 */
export async function twinOf(
	exec: Exec,
	path: string,
	origin: string,
	take: (common: string) => boolean = () => true,
): Promise<string | undefined> {
	const name = basename(path);
	let above = dirname(path);
	for (let level = 0; level < LEVELS; level++) {
		for (const candidate of beside(above, name)) {
			if (candidate === path) continue;
			const common = await commonOf(exec, candidate, origin);
			if (common !== undefined && take(common)) return common;
		}
		const up = dirname(above);
		if (up === above) return undefined;
		above = up;
	}
	return undefined;
}

/**
 * The git folder of a checkout the fence guards whose origin is
 * `origin`, for a tree where the work tool cuts them to be a worktree
 * of: one beside `path` as a twin is found, since a sibling tree is a
 * worktree of one, or one under `~/src` where the origin's own path
 * names it (`src/<host>/<owner>/<repo>`, `src/<owner>/<repo>` or
 * `src/<repo>`); or nothing.
 */
export async function guardedCheckoutOf(
	exec: Exec,
	path: string,
	origin: string,
	home: string,
): Promise<string | undefined> {
	const guarded = (common: string) => guardsGitFolder(real(common), real(home));
	const twin = await twinOf(exec, path, origin, guarded);
	if (twin !== undefined) return twin;
	for (const candidate of namedIn(home, origin)) {
		if (!existsSync(candidate)) continue;
		const common = await commonOf(exec, candidate, origin);
		if (common !== undefined && guarded(common)) return common;
	}
	return undefined;
}

/**
 * Where under `~/src` a checkout of `origin` would be, from the path
 * it names: `git@host:owner/repo.git`, a URL, or a plain path.
 */
function namedIn(home: string, origin: string): string[] {
	const scp = /^[^/@:]+@([^:/]+):(.+)$/.exec(origin);
	let host: string | undefined;
	let path = origin;
	if (scp) {
		host = scp[1];
		path = scp[2] ?? "";
	} else if (URL.canParse(origin)) {
		const url = new URL(origin);
		host = url.hostname === "" ? undefined : url.hostname;
		path = url.pathname;
	}
	const parts = path
		.replace(/\.git\/?$/, "")
		.split("/")
		.filter((part) => part !== "" && part !== "." && part !== "..");
	const repo = parts.at(-1);
	if (repo === undefined) return [];
	const owner = parts.at(-2);
	return [
		...(host !== undefined && owner !== undefined
			? [join(home, "src", host, owner, repo)]
			: []),
		...(owner === undefined ? [] : [join(home, "src", owner, repo)]),
		join(home, "src", repo),
	];
}

/** The folders in `folder`, and each one's own folder named `name`. */
function beside(folder: string, name: string): string[] {
	if (!existsSync(folder)) return [];
	let entries: string[];
	try {
		entries = readdirSync(folder, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && !entry.name.includes(CLONING))
			.map((entry) => entry.name)
			.sort()
			.slice(0, MOST_BESIDE);
	} catch {
		return [];
	}
	return entries
		.flatMap((entry) => [join(folder, entry, name), join(folder, entry)])
		.filter((candidate) => existsSync(candidate));
}

/**
 * The common git folder of the repository at `folder` when its origin is
 * `origin` and it holds every object of what it has; or nothing.
 */
async function commonOf(
	exec: Exec,
	folder: string,
	origin: string,
): Promise<string | undefined> {
	const said = async (...args: string[]) => {
		const result = await exec("git", ["-C", folder, ...args]);
		return result.code === 0 ? result.stdout.trim() : undefined;
	};
	if ((await said("config", "--get", "remote.origin.url")) !== origin) {
		return undefined;
	}
	if ((await said("rev-parse", "--is-shallow-repository")) !== "false") {
		return undefined;
	}
	if ((await said("config", "--get", "remote.origin.promisor")) === "true") {
		return undefined;
	}
	const common = await said(
		"rev-parse",
		"--path-format=absolute",
		"--git-common-dir",
	);
	if (common === undefined || !existsSync(join(common, "objects"))) {
		return undefined;
	}
	// One that borrows its objects holds only part of them; a clone of it
	// would borrow the same, and break when the lender prunes.
	if (existsSync(join(common, "objects", "info", "alternates"))) {
		return undefined;
	}
	return common;
}
