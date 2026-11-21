/**
 * Whether the commit a replay halted on has already landed on its base.
 *
 * Replays reapply cherry-picks (see `REAPPLY_CHERRY_PICKS` in `rebase.ts`),
 * so a commit the base already carries is replayed rather than dropped ahead
 * of time. Unchanged since, it applies empty and git drops it. Edited since,
 * it halts, and in a Markdown file the edit and the original both read as
 * additions over the commit's parent: the append settler (`appends.ts`) would
 * keep both, bringing the old text back beside the new and calling the replay
 * clean. Run on a scratch repo on 21 November, a landed log entry edited on
 * main came back as both its edited and its first wording.
 *
 * So before settling, a halt asks whether the commit's change to the files in
 * conflict is one the base gained since the branch left it. Only commits that
 * touched those files are read, and only their change to them, which is what
 * keeps this from the walk of every commit the flag exists to skip.
 */

import type { Exec } from "../exec/index.ts";
import { ask } from "./tree-git.ts";

/** A halted commit whose change to the files in conflict the base already has. */
export interface Landed {
	/** The commit being replayed, abbreviated. */
	readonly commit: string;
	/** The commit on the base that carries the same change, abbreviated. */
	readonly as: string;
	/** The files in conflict that both commits change alike. */
	readonly paths: readonly string[];
}

/**
 * How many of the base's commits touching the files in conflict are read:
 * far past what a log gains while a branch is open, and a bound on the reads
 * should one have gained thousands.
 */
const LOOK_BACK = 500;

/**
 * The commit on `onto` that carries the halted commit's change to `paths`,
 * when one does. Answers nothing when git can't say, so a halt it can't read
 * is settled as before.
 */
export async function landedAs(
	exec: Exec,
	treePath: string,
	onto: string,
	paths: readonly string[],
): Promise<Landed | undefined> {
	if (paths.length === 0) return undefined;
	const halted = await ask(exec, treePath, [
		"rev-parse",
		"--verify",
		"-q",
		"REBASE_HEAD",
	]);
	if (halted === undefined) return undefined;
	const fork = await ask(exec, treePath, ["merge-base", onto, halted]);
	if (fork === undefined) return undefined;
	const mine = await changeTo(exec, treePath, halted, paths);
	if (mine === undefined) return undefined;

	const since = await ask(exec, treePath, [
		"rev-list",
		"--no-merges",
		`--max-count=${LOOK_BACK}`,
		onto,
		`^${fork}`,
		"--",
		...paths.map(literal),
	]);
	for (const commit of since?.split("\n") ?? []) {
		if ((await changeTo(exec, treePath, commit, paths)) !== mine) continue;
		return {
			commit: await short(exec, treePath, halted),
			as: await short(exec, treePath, commit),
			paths,
		};
	}
	return undefined;
}

/**
 * What `commit` changed in `paths`, without the line numbers or blob ids a
 * cherry-pick changes, as git's patch id leaves them out. Nothing when it
 * changed none of them.
 */
async function changeTo(
	exec: Exec,
	treePath: string,
	commit: string,
	paths: readonly string[],
): Promise<string | undefined> {
	const said = await ask(exec, treePath, [
		"-c",
		"core.quotepath=off",
		"diff-tree",
		"-p",
		"-U0",
		"--root",
		"--no-color",
		"--no-ext-diff",
		"--no-renames",
		"--no-commit-id",
		commit,
		"--",
		...paths.map(literal),
	]);
	if (said === undefined) return undefined;
	const kept = said
		.split("\n")
		.filter((line) => !line.startsWith("@@") && !line.startsWith("index "));
	return kept.join("\n");
}

/** A path from the top of the tree, read as written. */
function literal(path: string): string {
	return `:(top,literal)${path}`;
}

/** The commit's abbreviated name, or its full one when git won't shorten it. */
async function short(
	exec: Exec,
	treePath: string,
	commit: string,
): Promise<string> {
	return (
		(await ask(exec, treePath, ["rev-parse", "--short", commit])) ?? commit
	);
}
