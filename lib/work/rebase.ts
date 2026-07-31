/**
 * Replaying a branch onto a new base.
 *
 * The interesting outcome is not success, it is the halt. A rebase that stops
 * on a conflict leaves the tree in a state that is neither where it was nor
 * where it was going, and a tool that reports "failed" and says no more has
 * handed back a repository the caller now has to diagnose from scratch. So a
 * halt is a first-class answer that names the commit it stopped on, the paths
 * that disagree, and the two ways out.
 *
 * Nothing here decides for you. Continuing needs the conflicts resolved, which
 * is work only a person or an agent reading the code can do, and abandoning
 * throws away whatever replaying had achieved so far. Both are refusals to
 * guess rather than missing features.
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Exec } from "../exec/index.js";
import { unattended } from "./unattended.js";

/** Where a replay got to. */
export type RebaseOutcome =
	| { kind: "replayed"; branch: string; onto: string; commits: number }
	| { kind: "already-there"; branch: string; onto: string }
	| {
			kind: "halted";
			branch: string;
			onto: string;
			/** The commit being replayed when it stopped, when git says. */
			at?: string;
			/** Paths that disagree, which is what has to be settled. */
			conflicted: readonly string[];
	  }
	| { kind: "refused"; reason: string };

/** How a halted replay ends. */
export type ResumeOutcome =
	| { kind: "replayed"; branch: string }
	| {
			kind: "halted";
			/**
			 * Which branch stopped, and onto what, when git's replay state says.
			 *
			 * Optional because a halt is reported from a tree whose HEAD is detached,
			 * so this is read from the replay in progress rather than from the tree,
			 * and a state git has half torn down may no longer say. It went unread
			 * for a while and the second halt of a stack printed no branch at all,
			 * which is the moment a reader most needs to know which one.
			 */
			branch?: string;
			onto?: string;
			at?: string;
			conflicted: readonly string[];
	  }
	| { kind: "abandoned"; branch: string }
	| { kind: "refused"; reason: string };

/** Replaying work in a tree. */
export interface WorkRebaser {
	rebase(treePath: string, onto: string): Promise<RebaseOutcome>;
	/** Carry on a halted replay, once the conflicts are settled. */
	resume(treePath: string): Promise<ResumeOutcome>;
	/** Put the tree back the way it was before the replay started. */
	abandon(treePath: string): Promise<ResumeOutcome>;
	/** Whether a replay is part-way through, which changes what is safe. */
	halted(treePath: string): Promise<boolean>;
}

/** Read one git value, scoped to the tree, or undefined when git says nothing. */
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

/** Paths git reports as unmerged. */
async function conflictedIn(
	exec: Exec,
	treePath: string,
): Promise<readonly string[]> {
	const said = await ask(exec, treePath, [
		"diff",
		"--name-only",
		"--diff-filter=U",
	]);
	return said === undefined ? [] : said.split("\n").filter((one) => one !== "");
}

/** Replay with plain git. */
export function createGitRebaser(deps: { exec: Exec }): WorkRebaser {
	const { exec } = deps;

	async function isHalted(treePath: string): Promise<boolean> {
		// Git keeps a directory while a rebase is in progress, and asking for it
		// is cheaper and more certain than parsing status output.
		//
		// Looked at directly rather than through `test -d`. A subprocess runs in
		// the process's own working directory, and git reports this path relative
		// to the tree, so the probe was asking about a directory beside whatever
		// directory pi happened to be started in. It answered "not rebasing" for
		// a tree that was mid-rebase, which is the answer that makes resume and
		// abandon refuse to work at the exact moment they are needed.
		for (const what of ["rebase-merge", "rebase-apply"]) {
			const said = await ask(exec, treePath, ["rev-parse", "--git-path", what]);
			if (said === undefined) continue;
			if (existsSync(isAbsolute(said) ? said : join(treePath, said)))
				return true;
		}
		return false;
	}

	/**
	 * What the replay in progress is doing, as far as git's state says.
	 *
	 * Read from the replay rather than from the tree, because a tree part-way
	 * through one has a detached HEAD: every ordinary way of asking which branch
	 * you are on answers "HEAD", which is why this went unreported for so long.
	 * Git writes the answer down, so the fix is to read what it wrote.
	 *
	 * Every field is best-effort. Nothing here is worth failing a halt over: a
	 * halt with no branch named is thin, and a halt that errored while trying to
	 * name one is worse.
	 */
	async function replaying(treePath: string): Promise<{
		branch?: string;
		onto?: string;
		at?: string;
	}> {
		const read = async (what: string): Promise<string | undefined> => {
			const said = await ask(exec, treePath, [
				"rev-parse",
				"--git-path",
				`rebase-merge/${what}`,
			]);
			if (said === undefined) return undefined;
			const where = isAbsolute(said) ? said : join(treePath, said);
			if (!existsSync(where)) return undefined;
			try {
				const text = readFileSync(where, "utf8").trim();
				return text === "" ? undefined : text;
			} catch {
				// Unreadable is the same as unsaid here: the halt is still a halt.
				return undefined;
			}
		};

		const head = await read("head-name");
		const onto = await read("onto");
		const at = await ask(exec, treePath, [
			"rev-parse",
			"--short",
			"REBASE_HEAD",
		]);
		return {
			// Git records the full ref; a reader wants the branch.
			...(head ? { branch: head.replace(/^refs\/heads\//, "") } : {}),
			...(onto ? { onto: await nameFor(treePath, onto) } : {}),
			...(at ? { at } : {}),
		};
	}

	/**
	 * What to call the commit a replay is heading for.
	 *
	 * Git records the target as a commit, because by then the ref that named it is
	 * beside the point: the replay is onto that commit whatever anybody does to the
	 * branch afterwards. But a halt reported from a resume then said "onto fc00dccd"
	 * where the same halt from starting the replay said "onto main", and the two are
	 * the same event to the person reading them.
	 *
	 * So the commit is named after a branch when exactly one branch is sitting on it.
	 * Exactly one, because more than one is genuinely ambiguous: the replay was onto
	 * some ref and nothing here records which, so picking one would be inventing the
	 * answer rather than reading it. The commit is the honest fallback, and it is
	 * what git had.
	 */
	async function nameFor(treePath: string, commit: string): Promise<string> {
		const short = commit.slice(0, 8);
		const said = await ask(exec, treePath, [
			"for-each-ref",
			"--format=%(refname:short)",
			"--points-at",
			commit,
			"refs/heads",
		]);
		if (said === undefined) return short;
		const names = said.split("\n").filter((one) => one !== "");
		return names.length === 1 && names[0] !== undefined ? names[0] : short;
	}

	return {
		halted: isHalted,

		async rebase(treePath, onto) {
			if (await isHalted(treePath)) {
				return {
					kind: "refused",
					reason:
						"A replay is already part-way through in this tree. Settle it first: resume it once the conflicts are resolved, or abandon it to put the tree back.",
				};
			}

			const branch = await ask(exec, treePath, [
				"rev-parse",
				"--abbrev-ref",
				"HEAD",
			]);
			if (branch === undefined || branch === "HEAD") {
				return {
					kind: "refused",
					reason:
						"This tree is not on a branch, so there is nothing to replay.",
				};
			}

			// Uncommitted work and a rebase do not mix, and git's own autostash
			// would hide the problem rather than state it. A caller who wants
			// the changes kept should commit them; one who does not should say
			// so out loud.
			const dirty = await ask(exec, treePath, ["status", "--porcelain"]);
			if (dirty !== undefined) {
				return {
					kind: "refused",
					reason: `This tree has uncommitted changes, and replaying would have to move them. Record them first, or set them aside deliberately.\n\n${dirty}`,
				};
			}

			const before = await ask(exec, treePath, [
				"rev-list",
				"--count",
				`${onto}..HEAD`,
			]);
			if (before === "0") {
				return { kind: "already-there", branch, onto };
			}

			const result = await exec(
				"git",
				unattended(["-C", treePath, "rebase", onto]),
			);
			if (result.code === 0) {
				return {
					kind: "replayed",
					branch,
					onto,
					commits: Number.parseInt(before ?? "0", 10) || 0,
				};
			}

			const conflicted = await conflictedIn(exec, treePath);
			if (conflicted.length > 0 || (await isHalted(treePath))) {
				const at = await ask(exec, treePath, [
					"rev-parse",
					"--short",
					"REBASE_HEAD",
				]);
				return {
					kind: "halted",
					branch,
					onto,
					...(at === undefined ? {} : { at }),
					conflicted,
				};
			}

			const said = [result.stderr.trim(), result.stdout.trim()]
				.filter((stream) => stream !== "")
				.join("\n");
			return {
				kind: "refused",
				reason: said || `git rebase exited ${result.code}`,
			};
		},

		async resume(treePath) {
			if (!(await isHalted(treePath))) {
				return {
					kind: "refused",
					reason: "No replay is part-way through in this tree.",
				};
			}
			const left = await conflictedIn(exec, treePath);
			if (left.length > 0) {
				return {
					kind: "halted",
					conflicted: left,
					...(await replaying(treePath)),
				};
			}

			// The call that hung. Continuing a conflicted pick commits with `-e`,
			// so without this git opens an editor on a stdin nobody is attached to
			// and waits for a human who will never arrive.
			const result = await exec(
				"git",
				unattended(["-C", treePath, "rebase", "--continue"]),
			);
			if (result.code !== 0) {
				const still = await conflictedIn(exec, treePath);
				if (still.length > 0)
					return {
						kind: "halted",
						conflicted: still,
						...(await replaying(treePath)),
					};
				return {
					kind: "refused",
					reason:
						result.stderr.trim() ||
						`git rebase --continue exited ${result.code}`,
				};
			}

			const branch =
				(await ask(exec, treePath, ["rev-parse", "--abbrev-ref", "HEAD"])) ??
				"HEAD";
			return { kind: "replayed", branch };
		},

		async abandon(treePath) {
			if (!(await isHalted(treePath))) {
				return {
					kind: "refused",
					reason: "No replay is part-way through in this tree.",
				};
			}
			const result = await exec(
				"git",
				unattended(["-C", treePath, "rebase", "--abort"]),
			);
			if (result.code !== 0) {
				return {
					kind: "refused",
					reason:
						result.stderr.trim() || `git rebase --abort exited ${result.code}`,
				};
			}
			const branch =
				(await ask(exec, treePath, ["rev-parse", "--abbrev-ref", "HEAD"])) ??
				"HEAD";
			return { kind: "abandoned", branch };
		},
	};
}
