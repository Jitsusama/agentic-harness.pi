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

import {
	existsSync,
	lstatSync,
	readFileSync,
	realpathSync,
	rmSync,
} from "node:fs";
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
 * none only where git listed its branches whole and named no such one,
 * saying nothing on standard error, since a ref it can't read is
 * skipped with a warning, and reading one as absent would have a
 * branch put back by deleting it. `rev-parse` can't tell absent from
 * unreadable, nor from a git that never ran: each answers 1.
 */
async function whereStands(
	exec: Exec,
	checkout: string,
	branch: string,
): Promise<{ readonly at: string | undefined } | { readonly why: string }> {
	const ref = `refs/heads/${branch}`;
	const listed = await exec("git", [
		`--git-dir=${checkout}`,
		"for-each-ref",
		"--format=%(objectname) %(refname)",
		ref,
	]);
	const said = listed.stderr.trim();
	if (listed.code !== 0 || said !== "") {
		return { why: said || `git answered ${listed.code}` };
	}
	const line = listed.stdout.split("\n").find((one) => one.endsWith(` ${ref}`));
	return { at: line?.slice(0, -` ${ref}`.length) };
}

/**
 * Takes out the tree `cut` made at `path`, git's entry for it alone, and
 * puts its branch back where it stood in the checkout where settling
 * moved it to `settled`, or takes out the one settling made; answers
 * what couldn't be, or nothing. Where settling never moved it
 * (`settled` is none), or anything else moved it meanwhile, the branch
 * is left where it is, as it is where the tree couldn't be taken out,
 * since that tree may still hold it; a tree gone, though git's entry
 * for it may stay, holds it no more. It never throws.
 */
export async function uncut(
	exec: Exec,
	cut: Cut,
	path: string,
	branch: string,
	settled: string | undefined,
): Promise<string | undefined> {
	const taken = await takenOut(exec, cut.checkout, path);
	if (taken !== undefined) {
		if (settled === undefined) return taken;
		// Gone, it holds the branch no more, though git's entry may say so.
		if (!existsSync(path)) {
			const put = await putBack(exec, cut, branch, settled);
			return put === undefined ? taken : `${taken}, and ${put}`;
		}
		return `${taken}, so its branch ${branch} was left where it stands`;
	}
	return settled === undefined
		? undefined
		: await putBack(exec, cut, branch, settled);
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
 * them, one that doesn't name the tree back, or can't be read, or where
 * .git is a link, which may be another tree's own .git file.
 */
function entryOf(path: string, checkout: string): string | undefined {
	try {
		const dotGit = join(path, ".git");
		if (!lstatSync(dotGit).isFile()) return undefined;
		const said = /^gitdir: (.+)$/m.exec(readFileSync(dotGit, "utf8"));
		if (!said?.[1]) return undefined;
		const entry = isAbsolute(said[1]) ? said[1] : resolve(path, said[1]);
		const worktrees = realpathSync(join(checkout, "worktrees"));
		const real = realpathSync(entry);
		if (real === worktrees || !within(real, worktrees)) return undefined;
		// Another tree's entry, named by a .git file planted here, stays.
		// Relative where git writes it so (worktree.useRelativePaths).
		const back = readFileSync(join(real, "gitdir"), "utf8").trim();
		return realpathSync(resolve(real, back)) === realpathSync(dotGit)
			? real
			: undefined;
	} catch {
		return undefined;
	}
}
