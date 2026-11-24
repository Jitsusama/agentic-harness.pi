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
	const stood = await exec("git", [
		`--git-dir=${checkout}`,
		"rev-parse",
		"--verify",
		"-q",
		`refs/heads/${branch}`,
	]);
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
	const before = stood.code === 0 ? stood.stdout.trim() : undefined;
	return { checkout, before };
}

/**
 * Takes out the tree `cut` made at `path`, git's entry for it alone, and
 * puts its branch back where it stood in the checkout, or takes out the
 * one settling made; answers what couldn't be, or nothing.
 */
export async function uncut(
	exec: Exec,
	cut: Cut,
	path: string,
	branch: string,
): Promise<string | undefined> {
	const git = (...args: string[]) =>
		exec("git", [`--git-dir=${cut.checkout}`, ...args]);
	const entry = entryOf(path, cut.checkout);
	const removed = await git("worktree", "remove", "--force", "--force", path);
	if (removed.code !== 0) {
		rmSync(path, { recursive: true, force: true });
		if (entry !== undefined) rmSync(entry, { recursive: true, force: true });
	}
	const ref = `refs/heads/${branch}`;
	const put =
		cut.before === undefined
			? await git("update-ref", "-d", ref)
			: await git("update-ref", ref, cut.before);
	return put.code === 0
		? undefined
		: `its branch ${branch} couldn't be put back in ${cut.checkout}: ${put.stderr.trim()}`;
}

/**
 * The folder in `checkout`'s worktrees that the worktree at `path` names
 * as its own, read from its .git file; none where it names one outside
 * them, or can't be read.
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
		return real !== worktrees && within(real, worktrees) ? real : undefined;
	} catch {
		return undefined;
	}
}
