/**
 * Recording work: staging, committing, and moving onto a branch.
 *
 * The history facet reads a tree and this one writes to it, kept
 * apart because reading is safe and writing is not. A consumer
 * that only wants to know whether a tree is dirty should not be
 * handed the ability to commit in it.
 *
 * Names are checked here rather than left to git, and not only for
 * the names git would reject anyway. The dangerous ones are the
 * names git accepts: a branch called `-rf` is a valid ref and a
 * flag to every command that later takes it, so it has to be
 * refused before it reaches a command line rather than after.
 */

import { type Exec, run } from "../review/providers/exec.js";

/** What a commit says. */
export interface CommitMessage {
	subject: string;
	body?: string;
}

/** Where a new branch starts. */
export interface BranchOptions {
	from?: string;
}

/** Writing to a tree. */
export interface WorkAuthor {
	/** Stage these paths, or everything when none are named. */
	stage(treePath: string, paths?: readonly string[]): Promise<void>;
	/** Record what is staged. */
	commit(treePath: string, message: CommitMessage): Promise<void>;
	/** Create a branch and check it out. */
	branch(
		treePath: string,
		name: string,
		options?: BranchOptions,
	): Promise<void>;
}

/**
 * Characters and shapes a ref may not carry.
 *
 * This is git's own `check-ref-format` rule set, minus the parts
 * that need a repo to answer, plus the leading dash. Doing it as a
 * deny list rather than an allow list is deliberate: branch names
 * legitimately carry slashes, dots and unicode, and an allow list
 * narrow enough to be safe would refuse names people already use.
 */
const UNSAFE_IN_REF =
	/[\s~^:?*[\\\u0000-\u001f\u007f]|\.\.|^-|^\/|\/$|\.lock$|^$/;

/**
 * A ref name, trimmed, or nothing when it is not safe to use.
 *
 * Returns the name rather than a boolean so a caller cannot check
 * one string and then pass a different one, which is the shape of
 * mistake that makes a validator decorative.
 */
export function safeBranchName(name: string): string | undefined {
	const trimmed = name?.trim() ?? "";
	if (trimmed === "" || UNSAFE_IN_REF.test(trimmed)) return undefined;
	return trimmed;
}

/** Write to a tree with plain git. */
export function createGitAuthor(deps: { exec: Exec }): WorkAuthor {
	return {
		async stage(treePath, paths) {
			// A bare `git add` stages nothing and reports success, so
			// everything has to be asked for by name.
			const args =
				paths && paths.length > 0 ? ["add", "--", ...paths] : ["add", "--all"];
			await run(
				deps.exec,
				"git",
				["-C", treePath, ...args],
				`Staging work in ${treePath}`,
			);
		},

		async commit(treePath, message) {
			const subject = message.subject?.trim() ?? "";
			if (subject === "") {
				throw new Error(
					"A commit needs a subject: it is the line everybody reads " +
						"when deciding whether to read the rest.",
				);
			}
			const body = message.body?.trim();
			await run(
				deps.exec,
				"git",
				[
					"-C",
					treePath,
					"commit",
					"-m",
					subject,
					// Git knows how a body is separated from a subject.
					// Splicing a blank line in by hand is how that gets
					// done differently in two places.
					...(body ? ["-m", body] : []),
				],
				`Recording work in ${treePath}`,
			);
		},

		async branch(treePath, name, options) {
			const safe = safeBranchName(name);
			if (!safe) {
				throw new Error(
					`Not a usable branch name: ${JSON.stringify(name)}. Names ` +
						"carrying spaces, a leading dash, or git's reserved " +
						"shapes are refused rather than corrected, since " +
						"quietly renaming somebody's branch is worse than " +
						"declining to make it.",
				);
			}
			let from: string | undefined;
			if (options?.from !== undefined) {
				from = safeBranchName(options.from);
				if (!from) {
					throw new Error(
						`Not a usable start point: ${JSON.stringify(options.from)}.`,
					);
				}
			}
			await run(
				deps.exec,
				"git",
				["-C", treePath, "checkout", "-b", safe, ...(from ? [from] : [])],
				`Making ${safe} in ${treePath}`,
			);
		},
	};
}
