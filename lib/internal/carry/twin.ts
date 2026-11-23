/**
 * A repository already on this machine with a carried tree's origin,
 * for arriving to clone from, borrowing its objects, rather than taking
 * every object from the origin again.
 *
 * World's trees on a Mac stand as `~/world/trees/<name>/src`, worktrees
 * of `~/world/git`, and a carried World tree cloned from Delta alone
 * received nothing in forty minutes on 23 November while its sibling
 * trees already held nearly every object. So the twin is looked for beside where the
 * tree goes: among the folders in its parent, its grandparent and the
 * folder above that, and in each one's own folder of the tree's name.
 * Only a repository that is neither shallow nor partial is taken, since
 * a clone borrowing from one would still lack what it left out.
 */

import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Exec } from "../../core/exec/index.ts";

/** How many folders above the tree's own are looked through. */
const LEVELS = 3;

/** How many folders in any one place are looked at, at most. */
const MOST_BESIDE = 64;

/**
 * The git common folder of a repository here whose origin is `origin`,
 * found beside `path`; or nothing.
 */
export async function twinOf(
	exec: Exec,
	path: string,
	origin: string,
): Promise<string | undefined> {
	const name = basename(path);
	let above = dirname(path);
	for (let level = 0; level < LEVELS; level++) {
		for (const candidate of beside(above, name)) {
			if (candidate === path) continue;
			const common = await commonOf(exec, candidate, origin);
			if (common !== undefined) return common;
		}
		const up = dirname(above);
		if (up === above) return undefined;
		above = up;
	}
	return undefined;
}

/** The folders in `folder`, and each one's own folder named `name`. */
function beside(folder: string, name: string): string[] {
	if (!existsSync(folder)) return [];
	let entries: string[];
	try {
		entries = readdirSync(folder, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
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
	return common;
}
