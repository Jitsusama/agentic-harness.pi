/**
 * Publishing a branch, which is the step between committing and proposing.
 *
 * It was missing, and its absence was the one place this surface made you
 * leave it: `work record` committed, `review_offer propose` needed the branch
 * on the remote, and nothing in between was a tool. Every other seam here is
 * something you can call.
 *
 * Two rules are built in rather than offered. A first push sets upstream,
 * because a branch that pushes without one has to be told its own name every
 * time afterwards and eventually gets told the wrong one. And a force is
 * always a lease: `--force` overwrites whatever arrived while you were
 * rebasing, which on a shared branch is somebody else's work, and the honest
 * version of "I know what is there" is to say what you think is there and be
 * refused when you are wrong.
 */

import type { Exec } from "../review/providers/exec.js";

/** Where a branch went, or why it did not. */
export type PushOutcome =
	| {
			kind: "published";
			branch: string;
			remote: string;
			/** True when this push is what gave the branch its upstream. */
			tracked: boolean;
			/** True when the push replaced commits the remote already had. */
			replaced: boolean;
	  }
	| { kind: "already-there"; branch: string; remote: string }
	| {
			kind: "refused";
			branch?: string;
			reason: string;
	  };

/** How to publish. */
export interface PushOptions {
	/**
	 * Replace what the remote has, refusing if it moved since you last
	 * fetched. Needed after a rebase, and never a bare force.
	 */
	replace?: boolean;
	/** Which remote. Defaults to the branch's upstream, then to origin. */
	remote?: string;
}

/** Publishing the work in a tree. */
export interface WorkPublisher {
	push(treePath: string, options?: PushOptions): Promise<PushOutcome>;
}

/** The remote a tree pushes to when nothing says otherwise. */
const DEFAULT_REMOTE = "origin";

/**
 * Read one git value, or undefined when git says nothing.
 *
 * Every call is scoped with `-C`, because the exec seam has no working
 * directory of its own: an unscoped git call runs wherever the process
 * happens to sit and answers confidently about the wrong repository.
 */
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

/** Publish with plain git. */
export function createGitPublisher(deps: { exec: Exec }): WorkPublisher {
	const { exec } = deps;

	return {
		async push(treePath, options = {}) {
			const branch = await ask(exec, treePath, [
				"rev-parse",
				"--abbrev-ref",
				"HEAD",
			]);
			if (branch === undefined || branch === "HEAD") {
				return {
					kind: "refused",
					reason:
						"This tree is not on a branch, so there is nothing to publish. Check one out, or make one with a branch action.",
				};
			}

			// An existing upstream is the honest default: pushing a tracked
			// branch somewhere else is how a fork ends up with a copy of a
			// branch nobody is watching.
			const upstream = await ask(exec, treePath, [
				"rev-parse",
				"--abbrev-ref",
				`${branch}@{upstream}`,
			]);
			const tracked = upstream !== undefined;
			const remote =
				options.remote ?? upstream?.split("/")[0] ?? DEFAULT_REMOTE;

			const known = await ask(exec, treePath, ["remote"]);
			if (known === undefined || !known.split("\n").includes(remote)) {
				return {
					kind: "refused",
					branch,
					reason: `This tree has no remote called ${remote}${known === undefined ? " and no remotes at all" : `, only ${known.split("\n").join(", ")}`}, so ${branch} has nowhere to go.`,
				};
			}

			const args = ["-C", treePath, "push"];
			// Lease, never bare force. The lease is what turns "overwrite it"
			// into "overwrite it if it is still what I last saw".
			if (options.replace) args.push("--force-with-lease");
			if (!tracked) args.push("--set-upstream");
			args.push(remote, branch);

			const result = await exec("git", args);
			if (result.code !== 0) {
				const said = [result.stderr.trim(), result.stdout.trim()]
					.filter((stream) => stream !== "")
					.join("\n");
				const stale = said.includes("stale info");
				return {
					kind: "refused",
					branch,
					reason: stale
						? `${remote}/${branch} moved since this tree last fetched it, so the lease was refused rather than overwriting work that arrived in the meantime. Fetch, look at what landed, then push again.\n\n${said}`
						: said || `git push exited ${result.code}`,
				};
			}

			// Git says this on stdout or stderr depending on version, and it
			// is the difference between a push that did something and one that
			// politely did nothing.
			const said = `${result.stdout}\n${result.stderr}`;
			if (said.includes("Everything up-to-date")) {
				return { kind: "already-there", branch, remote };
			}

			return {
				kind: "published",
				branch,
				remote,
				tracked: !tracked,
				replaced: options.replace === true,
			};
		},
	};
}
