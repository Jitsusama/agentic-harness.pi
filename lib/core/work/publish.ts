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
 * time afterwards and eventually gets told the wrong one; a branch that
 * tracks the branch it was cut from counts as having none. And a force is
 * always a lease: `--force` overwrites whatever arrived while you were
 * rebasing, which on a shared branch is somebody else's work, and the honest
 * version of "I know what is there" is to say what you think is there and be
 * refused when you are wrong.
 */

import type { Exec } from "../exec/index.ts";

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

/** Whether one fetch refspec brings a remote's ref in. */
export function refspecCovers(refspec: string, ref: string): boolean {
	const spec = refspec.trim().replace(/^\+/, "");
	// A negative refspec leaves refs out rather than bringing them in.
	if (spec.startsWith("^")) return false;
	const source = spec.split(":")[0] ?? "";
	const star = source.indexOf("*");
	if (star === -1) return source === ref;
	const before = source.slice(0, star);
	const after = source.slice(star + 1);
	return (
		ref.length >= before.length + after.length &&
		ref.startsWith(before) &&
		ref.endsWith(after)
	);
}

/**
 * Have the remote's fetch bring the branch in, when it does not yet.
 *
 * Git keeps a branch's tracking ref, resolves its upstream and works out
 * a lease only through the remote's fetch refspec. A checkout whose fetch
 * is narrowed to a few branches, as monorepo checkouts often are, left a
 * published branch with none of the three, so every later lease was
 * refused as stale, saying the remote had moved when nothing had. This
 * is what `git remote set-branches --add` is for, and it adds one branch,
 * the one being published, so the checkout stays narrow.
 */
async function fetchesBranch(
	exec: Exec,
	treePath: string,
	remote: string,
	branch: string,
): Promise<void> {
	const listed = await exec("git", [
		"-C",
		treePath,
		"config",
		"--get-all",
		`remote.${remote}.fetch`,
	]);
	const refspecs = listed.code === 0 ? listed.stdout.split("\n") : [];
	const ref = `refs/heads/${branch}`;
	if (refspecs.some((refspec) => refspecCovers(refspec, ref))) return;
	await exec("git", [
		"-C",
		treePath,
		"remote",
		"set-branches",
		"--add",
		remote,
		branch,
	]);
}

/**
 * Record what the remote now holds of a branch, as its tracking ref.
 *
 * A push writes it where the fetch covers the branch, but a push that
 * found the remote already there writes nothing, and a branch whose
 * fetch was only just added then had no tracking ref until the next
 * fetch. After a push that succeeded the remote holds exactly what was
 * pushed, so this writes no guess.
 */
async function recordRemote(
	exec: Exec,
	treePath: string,
	remote: string,
	branch: string,
	pushed: string | undefined,
): Promise<void> {
	if (pushed === undefined) return;
	const ref = `refs/remotes/${remote}/${branch}`;
	const recorded = await ask(exec, treePath, [
		"rev-parse",
		"--verify",
		"-q",
		ref,
	]);
	if (recorded === pushed) return;
	await exec("git", ["-C", treePath, "update-ref", ref, pushed]);
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
			//
			// Read from the branch's own settings rather than its upstream's
			// short name. Beside a local branch called origin/main, git spells
			// origin's main `remotes/origin/main` to keep the two apart, and the
			// first word of that was taken for the remote: "no remote called
			// remotes". A remote of `.` is this repo, which is no remote at all.
			const configured = await ask(exec, treePath, [
				"config",
				"--get",
				`branch.${branch}.remote`,
			]);
			const upstreamRemote =
				configured !== undefined && configured !== "" && configured !== "."
					? configured
					: undefined;
			const merge =
				upstreamRemote === undefined
					? undefined
					: await ask(exec, treePath, [
							"config",
							"--get",
							`branch.${branch}.merge`,
						]);
			// Tracked means tracking a branch of its own name. A branch cut from
			// `origin/main` starts out tracking main, and kept doing so after it
			// was published, so its status, its ahead and behind, and anything
			// reading its upstream all answered about main.
			const tracked = merge === `refs/heads/${branch}`;
			const remote = options.remote ?? upstreamRemote ?? DEFAULT_REMOTE;

			const known = await ask(exec, treePath, ["remote"]);
			if (known === undefined || !known.split("\n").includes(remote)) {
				return {
					kind: "refused",
					branch,
					reason: `This tree has no remote called ${remote}${known === undefined ? " and no remotes at all" : `, only ${known.split("\n").join(", ")}`}, so ${branch} has nowhere to go.`,
				};
			}

			await fetchesBranch(exec, treePath, remote, branch);

			// What is pushed, read now, so what the remote holds afterwards is
			// known rather than asked for again.
			const pushing = await ask(exec, treePath, [
				"rev-parse",
				"--verify",
				`refs/heads/${branch}`,
			]);

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
				if (stale) {
					return {
						kind: "refused",
						branch,
						reason: `${remote}/${branch} moved since this tree last fetched it, so the lease was refused rather than overwriting work that arrived in the meantime. Fetch, look at what landed, then push again.\n\n${said}`,
					};
				}

				// A branch that has diverged from its remote, which git reports with a
				// hint to run `git pull`. That hint is the reason this case is handled
				// rather than passed along: the commonest way to arrive here is having
				// rebased, and pulling then merges the old history back into the
				// rewritten one, producing exactly the tangle the rebase was for. The
				// right move is the lease, and this layer knows that because it is the
				// layer that does the rebasing.
				//
				// Which of the two happened is not knowable from here: a rewritten
				// history and somebody else's push look the same at the ref. So both
				// are named, with the counts, and the reader picks. Saying only the
				// likelier one would be the same mistake git's hint makes.
				if (!options.replace && said.includes("[rejected]")) {
					const counts = await ask(exec, treePath, [
						"rev-list",
						"--left-right",
						"--count",
						`refs/heads/${branch}...refs/remotes/${remote}/${branch}`,
					]);
					const [mine, theirs] = (counts ?? "").split(/\s+/);
					const apart =
						mine && theirs
							? `${remote}/${branch} has ${theirs} ${theirs === "1" ? "commit" : "commits"} this branch does not, and ${branch} has ${mine} ${mine === "1" ? "commit" : "commits"} it does not. `
							: `${branch} and ${remote}/${branch} have diverged. `;
					return {
						kind: "refused",
						branch,
						reason: `${apart}Git refused rather than dropping either side.\n\nIf you rebased this branch, that is your own history rewritten: push again with replace, which is a lease and still refuses if the remote moved since this tree last fetched. If somebody else pushed, fetch and read what landed first. Git's own hint below suggests pulling, which would merge their work into your rebase.\n\n${said}`,
					};
				}

				return {
					kind: "refused",
					branch,
					reason: said || `git push exited ${result.code}`,
				};
			}

			// Git says this on stdout or stderr depending on version, and it
			// is the difference between a push that did something and one that
			// politely did nothing.
			const said = `${result.stdout}\n${result.stderr}`;
			await recordRemote(exec, treePath, remote, branch, pushing);
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
