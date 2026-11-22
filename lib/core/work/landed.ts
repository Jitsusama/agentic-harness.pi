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
 * So before settling, a halt asks whether the commit is one the base gained
 * since the branch left it. Only commits that touched the files in conflict
 * are read, and only their change to them, in one `git log`, which is what
 * keeps this from the walk of every commit the flag exists to skip; a commit
 * whose change there matches is then read whole.
 *
 * A match throws the branch's side of those files away, so it is held to git's
 * patch id over the whole commit: the changed lines with the lines around
 * them, leaving out only line numbers, blob ids and trailing whitespace, and
 * a binary file, or one that isn't UTF-8, compared by its blob ids. The same
 * lines changed elsewhere in the file, among other lines, are not a landing,
 * and nor is another commit that made the same change to the log beside
 * changes of its own, as two commits adding one changelog bullet do. As with
 * git's patch id, a place is known only by the lines around it, so a change
 * among lines repeated elsewhere reads as either. A landing that changed on the way in (squashed
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
 * What a refusal says of a landing whose base side was already kept, since a
 * refusal answers only why, and the commit's dropped change would otherwise go
 * unseen.
 */
export function keptLine(one: Landed): string {
	return `${one.paths.join(", ")}: ${one.commit} had already landed as ${one.as}, so the base's side was kept before this.`;
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
	// `rev-list` never follows a file, so neither may the log it is held to.
	"-c",
	"log.follow=false",
	"log",
	"--no-merges",
	"--format=%x00%H %h",
	"-p",
	"-U3",
	"--text",
	"--no-textconv",
	"--no-color",
	"--no-ext-diff",
	"--no-renames",
	// A signature's lines would land among a commit's patch.
	"--no-show-signature",
];

/**
 * The commit on `onto` that carries the halted commit's change to `paths`,
 * when one does. Answers nothing when git can't say or its read can't be
 * trusted, so a match is never guessed: the settler then keeps both sides of
 * what only added, and nothing is thrown away.
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
	// Every merge base: with more than one, past one of them alone lie
	// commits the halted commit's own history already holds.
	const forks = (
		await ask(exec, treePath, ["merge-base", "--all", onto, halted])
	)?.split("\n");
	if (forks === undefined) return undefined;
	// Only the files the halted commit changed. A file the base renamed is in
	// conflict under the base's name, one the commit never touched: matched
	// alongside the rest, its branch side would be thrown away with theirs.
	const touched = await touchedBy(exec, treePath, halted, paths);
	if (touched.length === 0) return undefined;
	const pathspecs = ["--", ...touched.map(literal)];

	const read = await patches(exec, treePath, [
		"--no-walk",
		halted,
		...pathspecs,
	]);
	const [mine] = read ?? [];
	if (read?.length !== 1 || mine === undefined || !changesLines(mine.change))
		return undefined;
	const since = await patches(exec, treePath, [
		`--max-count=${LOOK_BACK}`,
		onto,
		...forks.map((fork) => `^${fork}`),
		...pathspecs,
	]);
	if (since === undefined) return undefined;
	const alike = since.filter((one) => one.change === mine.change);
	if (alike.length === 0) return undefined;
	// Alike in the log is not yet the same commit: as git's patch id does,
	// the rest of each commit has to match too.
	const rest = await restOf(exec, treePath, halted, touched);
	if (rest === undefined) return undefined;
	for (const one of alike) {
		// By its full id: an abbreviated one is a ref first, should one be named so.
		if ((await restOf(exec, treePath, one.full, touched)) === rest)
			return { commit: mine.commit, as: one.commit, paths: touched };
	}
	return undefined;
}

/**
 * A commit's change to every file but `touched`. Read without `--text`, so a
 * binary file prints no bytes, only its blob ids, which are what it is
 * matched by: its raw bytes would carry NULs, which end a commit's patch.
 */
async function restOf(
	exec: Exec,
	treePath: string,
	commit: string,
	touched: readonly string[],
): Promise<string | undefined> {
	const result = await exec("git", [
		"-C",
		treePath,
		"-c",
		"core.quotepath=off",
		"diff-tree",
		"--root",
		"--no-commit-id",
		"-p",
		"-U3",
		"--full-index",
		"--no-textconv",
		"--no-color",
		"--no-ext-diff",
		"--no-renames",
		commit,
		"--",
		...touched.map((path) => `:(top,exclude,literal)${path}`),
	]);
	return result.code === 0 ? normalised(result.stdout.split("\n")) : undefined;
}

/** Which of `paths` the commit changes, in the order given. */
async function touchedBy(
	exec: Exec,
	treePath: string,
	commit: string,
	paths: readonly string[],
): Promise<string[]> {
	const result = await exec("git", [
		"-C",
		treePath,
		"diff-tree",
		"--root",
		"--no-commit-id",
		"--no-renames",
		"--name-only",
		"-r",
		"-z",
		commit,
		"--",
		...paths.map(literal),
	]);
	if (result.code !== 0) return [];
	const named = new Set(result.stdout.split("\0"));
	return paths.filter((path) => named.has(path));
}

/** A commit's change to some files, as `patchesIn` reads it. */
interface Patch {
	/** The commit's full id, which names it whatever refs there are. */
	readonly full: string;
	/** The commit abbreviated, as it is said. */
	readonly commit: string;
	readonly change: string;
}

/**
 * Each commit `git log` printed with `PATCH`, newest first, with its change
 * kept only as far as a cherry-pick leaves it alone: not the line numbers,
 * blob ids or trailing whitespace (a CR among it), as git's patch id leaves
 * them out. Answers nothing unless the pieces name, in order, exactly the
 * commits `listed`: a NUL in a log, printed as it is, cuts a commit's patch
 * short and starts a piece of the file's own text, which may well look like a
 * commit's id, and compared, a cut patch could match up to the NUL.
 */
function patchesIn(
	said: string,
	listed: readonly string[],
): Patch[] | undefined {
	// Each commit's piece follows a NUL, so the text before the first is empty.
	const [before, ...pieces] = said.split("\0");
	if (before !== "" || pieces.length !== listed.length) return undefined;
	const read = pieces.map((piece) => {
		const [named = "", ...lines] = piece.split("\n");
		const [full = "", commit = ""] = named.split(" ");
		const from = lines.findIndex((line) => line.startsWith("diff --git "));
		const change = normalised(from < 0 ? [] : lines.slice(from));
		return { full, commit, change };
	});
	return read.every((one, at) => one.full === listed[at]) ? read : undefined;
}

/**
 * A patch's lines as git's patch id reads them: no line numbers, no blob ids
 * and no trailing whitespace (a CR among it). A file whose bytes the read
 * can't carry keeps its blob ids, which are then all that says what it
 * changed: a binary one, and one read as UTF-8 that isn't, whose unlike bytes
 * would each have come out as the same U+FFFD. A log that holds U+FFFD itself
 * keeps them too, so a landing in it is missed once the base has changed it
 * elsewhere, and the settler keeps both.
 */
function normalised(lines: readonly string[]): string {
	const files: string[][] = [];
	for (const line of lines) {
		if (line.startsWith("diff --git ") || files.length === 0) files.push([]);
		files[files.length - 1]?.push(line);
	}
	return files
		.flatMap((file) => {
			const lossy = file.some(
				(line) => line.startsWith("Binary files ") || line.includes("\uFFFD"),
			);
			return file
				.filter(
					(line) =>
						line !== "" &&
						!line.startsWith("@@") &&
						(lossy || !line.startsWith("index ")),
				)
				.map((line) => line.trimEnd());
		})
		.join("\n");
}

/**
 * The commits `args` select, each with its change as `patchesIn` reads it,
 * or nothing when git can't say or the read can't be trusted. What `git log`
 * prints is read whole: trimmed, as `ask` reads, only the oldest commit's
 * last line would lose its trailing whitespace. The same selection through
 * `rev-list`, which prints no file's text, says which commits there are.
 */
async function patches(
	exec: Exec,
	treePath: string,
	args: readonly string[],
): Promise<Patch[] | undefined> {
	const [printed, listed] = await Promise.all([
		exec("git", ["-C", treePath, ...PATCH, ...args]),
		exec("git", ["-C", treePath, "rev-list", "--no-merges", ...args]),
	]);
	if (printed.code !== 0 || listed.code !== 0) return undefined;
	return patchesIn(
		printed.stdout,
		listed.stdout.split("\n").filter((line) => line !== ""),
	);
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
