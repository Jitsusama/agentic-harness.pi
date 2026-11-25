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
	accessSync,
	constants,
	lstatSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { Exec } from "../../core/exec/index.ts";
import { within } from "../sandbox/tree-git.ts";
import { messageOf } from "./message.ts";

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
 * where git lists it, or none only where git then says outright that
 * its ref is missing, since reading one it can't read as absent would
 * have a branch put back by deleting it. Listing alone can't say so: it
 * skips a ref it can't read with a warning, as it does a broken one
 * beside it such as `topic-old`, and skips a folder of refs it can't
 * open without a word. `show-ref --exists` answers 2 for a missing ref
 * alone, and 1 for one it couldn't look up; `rev-parse` can't tell
 * absent from unreadable, nor from a git that never ran: each answers 1.
 * What else git says on standard error is no reason to refuse.
 *
 * A git older than 2.43 doesn't know `--exists`, answering 129, and
 * lenders and cloud machines run such a git, where refusing every new
 * branch would refuse every carry. There the ref's own file, where git
 * names it, is looked at instead: see {@link unlistedStands}.
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
	if (listed.code !== 0) return { why: whyOf(listed) };
	const line = listed.stdout.split("\n").find((one) => one.endsWith(` ${ref}`));
	if (line !== undefined) return { at: line.slice(0, -` ${ref}`.length) };
	const missing = await exec("git", [
		`--git-dir=${checkout}`,
		"show-ref",
		"--exists",
		ref,
	]);
	if (missing.code === MISSING) return { at: undefined };
	// The listing's own word on the ref, such as that it is broken, first.
	const named = listed.stderr
		.split("\n")
		.map((one) => one.trim())
		.filter((one) => one.endsWith(` ${ref}`));
	if (missing.code === UNKNOWN_OPTION && !killed(missing.stderr)) {
		if (named.length > 0) return { why: named.join("; ") };
		const file = await exec("git", [
			`--git-dir=${checkout}`,
			"rev-parse",
			"--git-path",
			ref,
		]);
		if (file.code !== 0) return { why: whyOf(file) };
		const stands = unlistedStands(file.stdout.trim(), ref);
		return stands === undefined ? { at: undefined } : { why: stands };
	}
	const why =
		missing.code === 0 ? `git has ${ref} but didn't list it` : whyOf(missing);
	return { why: [...named, why].join("; ") };
}

/** What `git show-ref --exists` answers for a ref that is missing, and only that. */
const MISSING = 2;

/**
 * What git answers for an option it doesn't know, as a git older than
 * 2.43 does `--exists`, printing its whole usage, which says nothing of
 * the ref.
 */
const UNKNOWN_OPTION = 129;

/**
 * Whether git was killed rather than answering, as exec says of one a
 * signal ended: 129 is also SIGHUP's 128 and 1, and a git hung up on
 * mustn't be taken for one too old to know `--exists`.
 */
function killed(stderr: string): boolean {
	return / was killed by SIG[A-Z0-9]+$/.test(stderr.trim());
}

/**
 * Why a ref the listing left out may still stand, for a git too old to
 * say so itself, looking at its loose file `file` as git names it: that
 * file is there, or a folder of refs on its way can't be read, which
 * the listing skips without a word. Undefined where neither, so it is
 * missing: a packed ref the listing would have read and listed.
 *
 * git prints the path as it was given the git dir, so it is resolved
 * first, against the folder git ran in, which is this process's: one
 * through `..`, `//` or a relative git dir is still the ref's own file.
 * Folders on the way are followed through links, as git follows them;
 * the ref's own file is not, since anything there, a link to nothing
 * included, may be a ref git reads.
 */
function unlistedStands(said: string, ref: string): string | undefined {
	const file = resolve(said);
	if (!file.endsWith(`/${ref}`)) {
		return `git named ${said} for ${ref}, which isn't its file`;
	}
	let at = `${file.slice(0, -ref.length)}refs`;
	for (const part of ["", ...ref.split("/").slice(1)]) {
		at = part === "" ? at : join(at, part);
		const own = at === file;
		let kind: ReturnType<typeof lstatSync>;
		try {
			kind = own ? lstatSync(at) : statSync(at);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			return `${at} can't be looked at: ${messageOf(error)}`;
		}
		if (own) {
			return kind.isDirectory()
				? `a folder of refs stands at ${file}, so git can't make ${ref} there`
				: `git has ${ref} at ${file} but didn't list it`;
		}
		if (!kind.isDirectory()) return undefined;
		try {
			accessSync(at, constants.R_OK | constants.X_OK);
		} catch {
			return `${at} can't be read, so git can't say whether ${ref} is there`;
		}
	}
	return undefined;
}

/** What git said on standard error, or the code it answered with. */
function whyOf(said: { code: number; stderr: string }): string {
	return said.stderr.trim() || `git answered ${said.code}`;
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
		if (isGone(path)) {
			const put = await putBack(exec, cut, branch, settled);
			return put === undefined ? taken : `${taken}, and ${put}`;
		}
		return `${taken}, so its branch ${branch} was left where it stands`;
	}
	return settled === undefined
		? undefined
		: await putBack(exec, cut, branch, settled);
}

/**
 * Whether nothing is at `path`, as the disk says outright: a path that
 * can't be seen, such as one under a folder that can't be read, may
 * still be a tree that holds its branch.
 */
function isGone(path: string): boolean {
	try {
		lstatSync(path);
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT";
	}
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
		return `the tree cut at ${path} couldn't be taken out: ${messageOf(error)}`;
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
