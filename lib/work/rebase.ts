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

import type { Exec } from "../review/providers/exec.js";

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
	| { kind: "halted"; conflicted: readonly string[] }
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
		// Git keeps a directory while a rebase is in progress, and asking for
		// it is cheaper and more certain than parsing status output.
		const said = await ask(exec, treePath, [
			"rev-parse",
			"--git-path",
			"rebase-merge",
		]);
		const apply = await ask(exec, treePath, [
			"rev-parse",
			"--git-path",
			"rebase-apply",
		]);
		for (const path of [said, apply]) {
			if (path === undefined) continue;
			const seen = await exec("test", ["-d", path]);
			if (seen.code === 0) return true;
		}
		return false;
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

			const result = await exec("git", ["-C", treePath, "rebase", onto]);
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
				return { kind: "halted", conflicted: left };
			}

			const result = await exec("git", [
				"-C",
				treePath,
				"rebase",
				"--continue",
			]);
			if (result.code !== 0) {
				const still = await conflictedIn(exec, treePath);
				if (still.length > 0) return { kind: "halted", conflicted: still };
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
			const result = await exec("git", ["-C", treePath, "rebase", "--abort"]);
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
