/**
 * The pre-flight's checks of git in a fenced worktree whose shared git
 * folder is read-only (`fence-git-root.ts`, ISXEG8 [753f43b4]): that
 * git's everyday work still goes (5e), and that git outside never sees
 * a name planted there (j), which fails the moment the folder is
 * writable with only the watch to guard it, since a watch loses that
 * race about once in 50 looks. And that git works in a tree the session
 * holds from a command started elsewhere (5f).
 */

import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createTreeMemory } from "../../core/work/memory.ts";
import { removeTree } from "../files/remove-tree.ts";
import { treeRecordDir } from "../work-records.ts";
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
		for (const path of [root, tree, remote]) removeTree(path);
	}
}

/**
 * Check (5f): git in a worktree the session holds but didn't start in.
 * An agent cuts a tree with the work tool and works in it from its
 * session's folder; on 15 November git there could write no index or
 * FETCH_HEAD inside, since only the start folder's own git folder was
 * bound back (ISXEG8 [0804813d]). A work record holds one tree for the
 * pre-flight's session; a commit and a fetch there must go, from a
 * command started in the scratch folder, while a second tree it doesn't
 * hold must still fail, so the check can't pass with the fence open.
 * pi's own write tool in a held tree is check 11's, in a session.
 */
export async function heldTreeGit(context: PreflightContext): Promise<Verdict> {
	const root = join(homedir(), "src", `.pi-${fresh()}`);
	const held = join(context.scratch, `held-tree-${fresh()}`);
	const unheld = join(context.scratch, `unheld-tree-${fresh()}`);
	const remote = join(context.scratch, `held-remote-${fresh()}`);
	const key = `pi-preflight-held-${fresh()}`;
	const record = join(treeRecordDir(), `${key}.json`);
	const work = (tree: string) =>
		`cd '${tree}' && echo x > f && git add f && git ${WHO} commit -qm x && git fetch -q origin`;
	try {
		const made = await outside(
			[
				`git init -q -b main '${remote}' && git -C '${remote}' ${WHO} commit -q --allow-empty -m base`,
				`git clone -q '${remote}' '${root}'`,
				`git -C '${root}' config commit.gpgsign false`,
				`git -C '${root}' worktree add -q -b held '${held}'`,
				`git -C '${root}' worktree add -q -b unheld '${unheld}'`,
			].join(" && "),
			context.scratch,
		);
		if (made.code !== 0) return failed(`no repository: ${tailOf(made)}`);
		// Written as the broker writes one, so this process's fence, which
		// answers from a kept listing, sees it at once.
		createTreeMemory(treeRecordDir()).remember({
			identity: { key, shareable: false },
			path: held,
			providerId: "git-worktree",
			sessions: [context.session],
		});
		const inHeld = await fenced(work(held), context.scratch, context.session);
		if (inHeld.code !== 0)
			return failed(`git in the held tree failed: ${tailOf(inHeld)}`);
		const inUnheld = await fenced(
			work(unheld),
			context.scratch,
			context.session,
		);
		if (inUnheld.code === 0)
			return failed(
				"git wrote in a tree the session doesn't hold: its git folder is writable",
			);
		return passed(
			`a commit and a fetch in a held tree from the scratch folder (${inHeld.ms} ms), and a tree not held still refused: ${tailOf(inUnheld, 1)}`,
		);
	} finally {
		// Forgotten as the broker forgets one, so this process's kept
		// listing drops it at once rather than a reading later.
		try {
			createTreeMemory(treeRecordDir()).forget(held);
		} catch {
			// The records couldn't be read for now: the file goes by its
			// name, and the listing sees it gone a reading later.
			rmSync(record, { force: true });
		}
		await outside(
			`git -C '${root}' worktree remove --force '${held}'; git -C '${root}' worktree remove --force '${unheld}'`,
			context.scratch,
		);
		for (const path of [root, held, unheld, remote]) removeTree(path);
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
		removeTree(root);
		removeTree(tree);
	}
}
