/**
 * What a tree currently holds, and whether anything may move it.
 *
 * The working layer needs this before it re-points a tree, because
 * stepping through a stack means checking a different commit out of
 * a directory somebody may be working in. Overwriting a modified
 * file is bad; overwriting an untracked one is unrecoverable, so an
 * untracked file counts as work here rather than as noise.
 */

import { type Exec, run } from "../exec/index.js";
import { displayPath } from "../ui/path.js";

/** One path git reports as changed, and how. */
export interface ChangedPath {
	path: string;
	/** Staged for commit, as opposed to modified in the tree. */
	staged: boolean;
	kind: "modified" | "added" | "deleted" | "renamed" | "untracked";
}

/** What a tree holds beyond its last commit. */
export interface WorkingState {
	clean: boolean;
	changed: readonly ChangedPath[];
}

/**
 * Where a tree points.
 *
 * `branch` is absent rather than empty when the tree is detached. A
 * snapshot is detached by design, so inventing a name would make
 * every snapshot look like a branch tree.
 */
export interface TreeHead {
	commit: string;
	branch?: string;
}

/** Reading a tree's current state. */
export interface WorkHistory {
	status(treePath: string): Promise<WorkingState>;
	head(treePath: string): Promise<TreeHead>;
}

/** Porcelain v1 status codes, mapped to what they mean. */
const KIND: Record<string, ChangedPath["kind"]> = {
	M: "modified",
	A: "added",
	D: "deleted",
	R: "renamed",
	C: "added",
	U: "modified",
};

/**
 * Read one porcelain v1 line.
 *
 * The format is two status columns then a space then the path, and a
 * rename carries both names as `old -> new`. The new name is the one
 * that matters: it is what is on disk, and what a re-point would
 * overwrite.
 */
function parseLine(line: string): ChangedPath | undefined {
	if (line.length < 4) return undefined;
	const [x, y] = [line[0], line[1]];
	const raw = line.slice(3);
	const path = raw.includes(" -> ") ? raw.split(" -> ")[1] : raw;
	if (path === undefined || path === "") return undefined;
	if (x === "?" && y === "?") {
		return { path, staged: false, kind: "untracked" };
	}
	const staged = x !== " " && x !== "?";
	const code = staged ? x : y;
	const kind = code === undefined ? undefined : KIND[code];
	if (kind === undefined) return undefined;
	return { path, staged, kind };
}

/** Read a tree's state with plain git. */
export function createGitHistory(deps: { exec: Exec }): WorkHistory {
	return {
		async status(treePath) {
			const out = await run(
				deps.exec,
				"git",
				["-C", treePath, "status", "--porcelain=v1", "--untracked-files=all"],
				`Reading what ${displayPath(treePath)} holds`,
			);
			const changed = out
				.split("\n")
				.map((line) => parseLine(line))
				.filter((entry): entry is ChangedPath => entry !== undefined);
			return { clean: changed.length === 0, changed };
		},

		async head(treePath) {
			const commit = (
				await run(
					deps.exec,
					"git",
					["-C", treePath, "rev-parse", "HEAD"],
					`Reading where ${displayPath(treePath)} points`,
				)
			).trim();
			// A detached tree makes this fail rather than answer, which
			// is the answer: there is no branch to name.
			const branch = await deps.exec("git", [
				"-C",
				treePath,
				"symbolic-ref",
				"--short",
				"HEAD",
			]);
			if (branch.code !== 0) return { commit };
			const name = branch.stdout.trim();
			return name === "" ? { commit } : { commit, branch: name };
		},
	};
}

/** How many paths a refusal names before it summarises. */
const NAMED_IN_REFUSAL = 5;

/**
 * Why a tree may not be re-pointed, or nothing if it may.
 *
 * Returns the sentence rather than a boolean, because a refusal that
 * does not say what is in the way leaves the person to go and look,
 * which is the entire cost of refusing.
 */
export function blocksRepoint(state: WorkingState): string | undefined {
	if (state.clean) return undefined;
	const named = state.changed.slice(0, NAMED_IN_REFUSAL).map((c) => c.path);
	const rest = state.changed.length - named.length;
	const tail = rest > 0 ? `, and ${rest} more` : "";
	return `This tree is holding uncommitted work (${named.join(", ")}${tail}), so re-pointing it would throw that away. Commit it, stash it, or ask for a different tree.`;
}
