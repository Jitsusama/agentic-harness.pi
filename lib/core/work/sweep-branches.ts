/**
 * The sweep's search for branches trunk holds whose trees went first.
 *
 * A branch whose tree went before its pull request merged is left by
 * the tree's own taking, so every checkout a record names is searched
 * for branches origin's trunk holds that nobody has moved since a
 * cut-off, which go with their config sections (`merged-branch.ts`). On
 * 19 November core.nix's checkout held 5,734 branches and 518 KB of
 * config, which every git command there read.
 */

import { basename, dirname, join, resolve } from "node:path";
import type { HeldTree } from "./broker.ts";
import { readPlain } from "./plain-file.ts";
import { dropSettledMergedBranches } from "./merged-branch.ts";
import type { SweepDeps, SweepOutcome } from "./sweep.ts";
import { mainCheckoutOf } from "./sweep-idle.ts";

/**
 * Drop the branches origin's trunk holds, unmoved since
 * `settledBefore`, in every checkout a record names: those whose trees
 * this sweep judged, and those of the git worktrees still held, whose
 * checkouts gather branches from trees released before their pull
 * request merged. `heldWorktrees` holds git worktrees only: another
 * provider's tree, such as a World dev tree, keeps its branches by its
 * own rules, so the caller leaves it out.
 */
export async function dropSettledBranches(
	deps: Pick<SweepDeps, "exec">,
	judged: readonly string[],
	heldWorktrees: readonly HeldTree[],
	settledBefore: number,
	outcome: Pick<SweepOutcome, "branches">,
): Promise<void> {
	const mains = new Set(judged);
	const asked = new Set<string>();
	for (const tree of heldWorktrees) {
		if (asked.has(tree.path)) continue;
		asked.add(tree.path);
		const main =
			checkoutNamedBy(tree.path) ??
			(await mainCheckoutOf(deps.exec, tree.path));
		if (main !== undefined) mains.add(main);
	}
	for (const main of mains) {
		const went = await dropSettledMergedBranches(
			deps.exec,
			main,
			settledBefore,
		);
		if (went.length > 0) outcome.branches.push({ checkout: main, went });
	}
}

/**
 * The main checkout a worktree was cut from, as its `.git` file and its
 * git folder's `commondir` say, or nothing where they can't be read.
 * Read from the files rather than asked of git, since every sweep asks
 * it of every held tree, hundreds on a busy machine.
 */
function checkoutNamedBy(tree: string): string | undefined {
	// No plain `.git` file or `commondir` leaves git to be asked instead.
	const said = /^gitdir: (.+)$/m.exec(readPlain(join(tree, ".git")) ?? "")?.[1];
	if (said === undefined) return undefined;
	const gitDir = resolve(tree, said.trim());
	const named = readPlain(join(gitDir, "commondir"))?.trim();
	if (named === undefined) return undefined;
	const common = resolve(gitDir, named);
	return basename(common) === ".git" ? dirname(common) : common;
}
