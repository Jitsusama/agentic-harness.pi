/**
 * A carried tree cut as a worktree of a checkout the fence guards, and
 * taken out again, leaving the checkout as it found it.
 *
 * A tree where the work tool cuts them must be a worktree: pi runs git
 * there outside the fence, and only a worktree of a checkout the fence
 * guards has settings no fenced command could have written
 * (tree-git.ts), so a clone there was refused by every review and work
 * call made in it. The checkout is the person's, so a cut that fails, or
 * a tree refused once cut, touches nothing in it the arrival didn't make.
 */

import { readFileSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { Exec } from "../../core/exec/index.ts";
import { within } from "../sandbox/tree-git.ts";

/** A tree cut from the checkout whose git folder is `checkout`. */
export interface Cut {
	readonly checkout: string;
	/** Where its branch stood in the checkout before, or none where it wasn't. */
	readonly before: string | undefined;
}

/**
 * The worktree of the checkout whose git folder is `checkout` that has
 * `branch` checked out, if one does: a tree cut beside it shares its
 * branches, and settling would move that one's from under it.
 */
export async function holderOf(
	exec: Exec,
	checkout: string,
	branch: string,
): Promise<string | undefined> {
	const listed = await exec("git", [
		`--git-dir=${checkout}`,
		"worktree",
		"list",
		"--porcelain",
	]);
	if (listed.code !== 0) {
		return `${checkout}, or may be, as its worktrees can't be listed: ${listed.stderr.trim()}`;
	}
	let at: string | undefined;
	for (const line of listed.stdout.split("\n")) {
		if (line.startsWith("worktree ")) at = line.slice("worktree ".length);
		if (line === `branch refs/heads/${branch}`) return at ?? checkout;
	}
	return undefined;
}

/**
 * The tree cut at `path` as a worktree of the checkout whose git folder
 * is `checkout`, empty and on no branch until it is settled, noting
 * where `branch` stood there; or why not. A cut git refused takes out
 * nothing, since git leaves nothing of one, and anything at `path` then
 * is another's.
 */
export async function cutFrom(
	exec: Exec,
	checkout: string,
	path: string,
	branch: string,
): Promise<Cut | { readonly why: string }> {
	const stood = await whereStands(exec, checkout, branch);
	if ("why" in stood) {
		return { why: `git couldn't read ${branch} in ${checkout}: ${stood.why}` };
	}
	const cut = await exec("git", [
		`--git-dir=${checkout}`,
		"worktree",
		"add",
		"-q",
		"--no-checkout",
		"--detach",
		path,
	]);
	if (cut.code !== 0) {
		return {
			why: `git couldn't cut it from ${checkout}: ${cut.stderr.trim()}`,
		};
	}
	return { checkout, before: stood.at };
}

/**
 * Where `branch` stands in the checkout whose git folder is `checkout`:
 * none only where git says it isn't there (`rev-parse -q` answers 1),
 * since any other failure says nothing of whether it is, and reading it
 * as absent would have a branch put back by deleting it.
 */
async function whereStands(
	exec: Exec,
	checkout: string,
	branch: string,
): Promise<{ readonly at: string | undefined } | { readonly why: string }> {
	const stood = await exec("git", [
		`--git-dir=${checkout}`,
		"rev-parse",
		"--verify",
		"-q",
		`refs/heads/${branch}`,
	]);
	if (stood.code === 0) return { at: stood.stdout.trim() };
	if (stood.code === 1) return { at: undefined };
	return {
		why: stood.stderr.trim() || `rev-parse answered ${stood.code}`,
	};
}

/**
 * Takes out the tree `cut` made at `path`, git's entry for it alone, and
 * puts its branch back where it stood in the checkout where settling
 * moved it to `settled`, or takes out the one settling made; answers
 * what couldn't be, or nothing. A branch anything else moved meanwhile
 * is left where it is, and it never throws.
 */
export async function uncut(
	exec: Exec,
	cut: Cut,
	path: string,
	branch: string,
	settled: string,
): Promise<string | undefined> {
	const left: string[] = [];
	const taken = await takenOut(exec, cut.checkout, path);
	if (taken !== undefined) left.push(taken);
	const put = await putBack(exec, cut, branch, settled);
	if (put !== undefined) left.push(put);
	return left.length === 0 ? undefined : left.join(", and ");
}

/** Takes out the tree at `path` and its entry; answers why not, or nothing. */
async function takenOut(
	exec: Exec,
	checkout: string,
	path: string,
): Promise<string | undefined> {
	const entry = entryOf(path, checkout);
	const removed = await exec("git", [
		`--git-dir=${checkout}`,
		"worktree",
		"remove",
		"--force",
		"--force",
		path,
	]);
	if (removed.code === 0) return undefined;
	try {
		rmSync(path, { recursive: true, force: true });
		if (entry !== undefined) {
			rmSync(entry, { recursive: true, force: true });
			return undefined;
		}
		// Pruning would take out other trees' entries too, so it is named.
		return `git's entry for the tree cut at ${path} may be left in ${checkout}, where git worktree prune takes it out`;
	} catch (error) {
		return `the tree cut at ${path} couldn't be taken out: ${error instanceof Error ? error.message : String(error)}`;
	}
}

/**
 * Puts `branch` back where `cut` found it, only where it still stands
 * where settling left it: git's update-ref is given that as the old
 * value, so it refuses a branch moved meanwhile.
 */
async function putBack(
	exec: Exec,
	cut: Cut,
	branch: string,
	settled: string,
): Promise<string | undefined> {
	const stands = await whereStands(exec, cut.checkout, branch);
	if ("why" in stands) {
		return `its branch ${branch} couldn't be read in ${cut.checkout}, so it was left: ${stands.why}`;
	}
	// Settling never moved it, or something else did since.
	if (stands.at !== settled || stands.at === cut.before) return undefined;
	const ref = `refs/heads/${branch}`;
	const put = await exec("git", [
		`--git-dir=${cut.checkout}`,
		"update-ref",
		...(cut.before === undefined
			? ["-d", ref, settled]
			: [ref, cut.before, settled]),
	]);
	return put.code === 0
		? undefined
		: `its branch ${branch} couldn't be put back in ${cut.checkout}: ${put.stderr.trim()}`;
}

/**
 * The folder in `checkout`'s worktrees that the worktree at `path` names
 * as its own, read from its .git file; none where it names one outside
 * them, one that doesn't name the tree back, or can't be read.
 */
function entryOf(path: string, checkout: string): string | undefined {
	try {
		const said = /^gitdir: (.+)$/m.exec(
			readFileSync(join(path, ".git"), "utf8"),
		);
		if (!said?.[1]) return undefined;
		const entry = isAbsolute(said[1]) ? said[1] : resolve(path, said[1]);
		const worktrees = realpathSync(join(checkout, "worktrees"));
		const real = realpathSync(entry);
		if (real === worktrees || !within(real, worktrees)) return undefined;
		// Another tree's entry, named by a .git file planted here, stays.
		const back = readFileSync(join(real, "gitdir"), "utf8").trim();
		return realpathSync(back) === realpathSync(join(path, ".git"))
			? real
			: undefined;
	} catch {
		return undefined;
	}
}
