/**
 * The pre-flight's checks of git in a fenced worktree whose shared git
 * folder is read-only (`fence-git-root.ts`, ISXEG8 [753f43b4]): that
 * git's everyday work still goes (5e), and that git outside never sees
 * a name planted there (j), which fails the moment the folder is
 * writable with only the watch to guard it, since a watch loses that
 * race about once in 50 looks.
 */

import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { routedPackedRefs } from "./fence-git-route.ts";
import {
	failed,
	fenced,
	fresh,
	outside,
	type PreflightContext,
	passed,
	tailOf,
	type Verdict,
} from "./fence-preflight.ts";

/** How many times a plant is tried inside, and git asked outside. */
const LOOKS = 50;

/** How long the planting loop inside may take. */
const PLANTING_LIMIT_MS = 60_000;

/** An author for the throwaway repositories' commits. */
const WHO = "-c user.name=p -c user.email=p@p";

/**
 * Check (5e): git's everyday work in a fenced worktree whose shared git
 * folder is read-only: a commit, a branch, a fetch, a rebase and status
 * inside, writing the tree's own index, HEAD and ORIG_HEAD, then a push
 * of what it made. The push goes from outside, as the work tool pushes,
 * and a fenced push to a local remote shows git's side of it works
 * inside too. A branch delete fails inside, and git's words for it are
 * the ones the route is added to.
 *
 * The signing agent is never reached inside, so a signed commit fails
 * there whatever the layout; agents commit and rebase with the work
 * tool, signed outside (check 5d). So this throwaway repository turns
 * signing off in its own settings for what's made inside, and a commit
 * made outside afterwards signs as the person's settings say, as the
 * work tool's record does.
 */
export async function everydayGit(context: PreflightContext): Promise<Verdict> {
	const root = join(homedir(), "src", `.pi-${fresh()}`);
	const tree = join(context.scratch, `git-tree-${fresh()}`);
	const remote = join(context.scratch, `git-remote-${fresh()}`);
	const own = (name: string) =>
		join(root, ".git", "worktrees", basename(tree), name);
	try {
		const made = await outside(
			[
				`git init -q -b main '${remote}' && git -C '${remote}' ${WHO} commit -q --allow-empty -m base`,
				`git clone -q '${remote}' '${root}'`,
				`git -C '${root}' branch gone && git -C '${root}' pack-refs --all`,
				`git -C '${root}' worktree add -q -b work '${tree}'`,
				`git -C '${root}' config commit.gpgsign false`,
				`git -C '${remote}' ${WHO} commit -q --allow-empty -m ahead`,
			].join(" && "),
			context.scratch,
		);
		if (made.code !== 0) return failed(`no repository: ${tailOf(made)}`);
		const inside = await fenced(
			[
				"set -e",
				`echo x > f && git add f && git ${WHO} commit -qm x`,
				"git branch made-inside",
				"git fetch -q origin",
				`git ${WHO} rebase -q origin/main`,
				"git status --short",
				`test -f '${own("ORIG_HEAD")}'`,
				`touch '${own("index")}' '${own("HEAD")}' '${own("ORIG_HEAD")}'`,
				"git push -q origin made-inside",
			].join("\n"),
			tree,
			context.session,
		);
		if (inside.code !== 0)
			return failed(`git inside failed: ${tailOf(inside)}`);
		const pushed = await outside(
			[
				`git -C '${root}' config --unset commit.gpgsign`,
				`echo y > '${join(tree, "g")}' && git -C '${tree}' add g && git -C '${tree}' commit -qm outside`,
				`git -C '${tree}' push -q origin work`,
				`git -C '${remote}' rev-parse -q --verify work > /dev/null`,
				`git -C '${remote}' rev-parse -q --verify made-inside > /dev/null`,
			].join(" && "),
			context.scratch,
		);
		if (pushed.code !== 0)
			return failed(`the push from outside failed: ${tailOf(pushed)}`);
		const deleted = await fenced("git branch -D gone", tree, context.session);
		if (deleted.code === 0)
			return failed(
				"a packed branch was deleted inside: the shared folder is writable",
			);
		if (!routedPackedRefs([{ type: "text", text: deleted.err }], () => {}))
			return failed(
				`a branch delete failed without the route: ${tailOf(deleted)}`,
			);
		return passed(
			`commit, branch, fetch, rebase, status and push inside (${inside.ms} ms), own index, HEAD and ORIG_HEAD written, the push from outside landed, and a branch delete refused with the route`,
		);
	} finally {
		await outside(
			`git -C '${root}' worktree remove --force '${tree}'`,
			context.scratch,
		);
		for (const path of [root, tree, remote])
			rmSync(path, { recursive: true, force: true });
	}
}

/**
 * Check (j): git outside a tree finds no redirect while a plant is
 * tried inside. The plant fails at the read-only bind; were the folder
 * ever writable with only the watch, git outside would see it.
 */
export async function plantLoop(context: PreflightContext): Promise<Verdict> {
	const root = join(homedir(), "src", `.pi-${fresh()}`);
	const tree = join(context.scratch, "plant-tree");
	try {
		const made = await outside(
			[
				`git init -q '${root}'`,
				`git -C '${root}' ${WHO} commit -q --allow-empty -m p`,
				`git -C '${root}' worktree add -q '${tree}'`,
			].join(" && "),
			context.scratch,
		);
		if (made.code !== 0) return failed(`no repository: ${tailOf(made)}`);
		const commondir = join(root, ".git", "commondir");
		const planting = fenced(
			`for i in $(seq ${LOOKS}); do printf '%s\\n' /tmp > '${commondir}' 2>/dev/null; sleep 0.05; done; true`,
			tree,
			`${fresh()}-plant`,
			PLANTING_LIMIT_MS,
		);
		let redirects = 0;
		const unanswered: string[] = [];
		for (let look = 0; look < LOOKS; look++) {
			const ran = await outside(
				`git -C '${root}' rev-parse --git-common-dir`,
				context.scratch,
			);
			// A failed look counts too: a planted commondir naming a folder
			// that isn't git's makes git outside fail, which is the plant
			// seen before the watcher removed it. What it said is kept.
			if (ran.out.trim() === ".git") continue;
			redirects++;
			if (ran.code !== 0) unanswered.push(tailOf(ran));
		}
		await planting;
		const left = existsSync(commondir);
		const failures = unanswered.length
			? `; ${unanswered.length} of them failed, the last saying: ${unanswered.at(-1)}`
			: "";
		return redirects === 0 && !left
			? passed(
					`${LOOKS} looks outside found no redirect, and no commondir was left${failures}`,
				)
			: failed(
					`${redirects} redirects seen; commondir left: ${left}${failures}`,
				);
	} finally {
		rmSync(join(root, ".git", "commondir"), { force: true });
		rmSync(root, { recursive: true, force: true });
		rmSync(tree, { recursive: true, force: true });
	}
}
