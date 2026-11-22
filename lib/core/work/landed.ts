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
 * touched those files are read, and only their change to them, in one git
 * process, which is what keeps this from the walk of every commit the flag
 * exists to skip.
 *
 * A match throws the branch's side of those files away, so it is held to git's
 * patch id: the changed lines with the lines around them, leaving out only line
 * numbers, blob ids and trailing whitespace. The same lines changed elsewhere in
 * the file are not a landing. A landing that changed on the way in (squashed
 * with others, renumbered, or landed after the base moved the lines around it)
 * is not found, and the settler keeps both sides, as it did before the flag,
 * when git's own search missed those too.
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
 * How many of the base's commits touching the files in conflict are read,
 * newest first: far past what a log gains while a branch is open, and a bound
 * on the patches read should one have gained thousands. A landing older than
 * that is not found, and is settled as before.
 */
const LOOK_BACK = 500;

/**
 * What reads a commit's change to some files, the same way for every commit:
 * as text with git's usual three lines around each change, whatever the
 * tree's attributes say. A file marked `-diff` would otherwise print every
 * change as the same "Binary files differ", and a textconv would print a
 * lossy reading, either of which could make unlike changes match.
 */
const PATCH = [
	"-c",
	"core.quotepath=off",
	"log",
	"--no-merges",
	"--format=%x00%h",
	"-p",
	"-U3",
	"--text",
	"--no-textconv",
	"--no-color",
	"--no-ext-diff",
	"--no-renames",
];

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
	const pathspecs = ["--", ...paths.map(literal)];

	const [mine] = patchesIn(
		await patches(exec, treePath, ["-1", halted, ...pathspecs]),
	);
	if (mine === undefined || !changesLines(mine.change)) return undefined;
	const since = patchesIn(
		await patches(exec, treePath, [
			`--max-count=${LOOK_BACK}`,
			onto,
			`^${fork}`,
			...pathspecs,
		]),
	);
	const landing = since.find((one) => one.change === mine.change);
	if (landing === undefined) return undefined;
	return { commit: mine.commit, as: landing.commit, paths };
}

/**
 * Each commit `git log` printed with `PATCH`, newest first, with its change
 * kept only as far as a cherry-pick leaves it alone: not the line numbers,
 * blob ids or trailing whitespace (a CR among it), as git's patch id leaves
 * them out.
 */
function patchesIn(
	said: string | undefined,
): { commit: string; change: string }[] {
	if (said === undefined) return [];
	return said
		.split("\0")
		.filter((chunk) => chunk.trim() !== "")
		.map((chunk) => {
			const [commit = "", ...lines] = chunk.split("\n");
			const from = lines.findIndex((line) => line.startsWith("diff --git "));
			const change = (from < 0 ? [] : lines.slice(from))
				.filter(
					(line) =>
						line !== "" && !line.startsWith("@@") && !line.startsWith("index "),
				)
				.map((line) => line.trimEnd())
				.join("\n");
			return { commit: commit.trim(), change };
		});
}

/**
 * What `git log` prints with `PATCH`, read whole: trimmed, as `ask` reads,
 * only the oldest commit's last line would lose its trailing whitespace.
 */
async function patches(
	exec: Exec,
	treePath: string,
	args: readonly string[],
): Promise<string | undefined> {
	const result = await exec("git", ["-C", treePath, ...PATCH, ...args]);
	return result.code === 0 ? result.stdout : undefined;
}

/** Whether a change adds or removes a line, rather than only naming files. */
function changesLines(change: string): boolean {
	return change
		.split("\n")
		.some(
			(line) =>
				(line.startsWith("+") && !line.startsWith("+++ ")) ||
				(line.startsWith("-") && !line.startsWith("--- ")),
		);
}

/** A path from the top of the tree, read as written. */
function literal(path: string): string {
	return `:(top,literal)${path}`;
}
