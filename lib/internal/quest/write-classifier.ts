/**
 * Classifies a write target into one of four categories so the
 * quest gate can decide whether to allow, defer or supply. The
 * classifier is pure: filesystem and git signals arrive as
 * injected predicates, so the ladder is unit-testable without
 * real `.git` fixtures. The risky production predicates (git
 * ignore resolution, index membership, working-tree discovery)
 * are wired in by the caller and covered separately.
 *
 * Tracked code and untracked-in-tree are kept distinct because
 * git's ignore answer cannot tell a forgotten scratch directory
 * from a new source file. Deferring only tracked edits during
 * the plan phase keeps the discipline honest without ever
 * cornering new work.
 */

import * as path from "node:path";

/** The category a write target falls into. */
export type WriteCategory =
	| "quest-internal"
	| "scratch"
	| "tracked-code"
	| "untracked-in-tree"
	| "loose-file";

/** The classifier's verdict for one write target. */
export interface WriteClassification {
	category: WriteCategory;
	/** For tracked-code, the git working tree root containing the target. */
	treeRoot?: string;
}

/** Signals the classifier needs, injected so the ladder stays pure. */
export interface ClassifyWriteOptions {
	/** The loaded quest's own directory, or null when none is loaded. */
	questDir: string | null;
	/** Directories whose contents are always scratch (temp dir, configured roots). */
	scratchRoots: string[];
	/** Whether the target is gitignored at its destination. */
	isGitignored: (absPath: string) => boolean;
	/** Whether the target is tracked in its repository's index. */
	isTracked: (absPath: string) => boolean;
	/** The git working tree root containing the target, or null when none. */
	gitTreeRootOf: (absPath: string) => string | null;
}

/**
 * Classify an absolute, already-resolved write target. The caller
 * resolves and canonicalizes the path before calling.
 */
/** Whether `target` is `dir` itself or sits anywhere beneath it. */
function isUnder(target: string, dir: string): boolean {
	const base = path.resolve(dir);
	const resolved = path.resolve(target);
	return resolved === base || resolved.startsWith(`${base}${path.sep}`);
}

export function classifyWrite(
	target: string,
	opts: ClassifyWriteOptions,
): WriteClassification {
	if (opts.questDir && isUnder(target, opts.questDir)) {
		return { category: "quest-internal" };
	}
	if (opts.scratchRoots.some((root) => isUnder(target, root))) {
		return { category: "scratch" };
	}
	if (opts.isGitignored(target)) {
		return { category: "scratch" };
	}
	const treeRoot = opts.gitTreeRootOf(target);
	if (treeRoot) {
		const category = opts.isTracked(target)
			? "tracked-code"
			: "untracked-in-tree";
		return { category, treeRoot };
	}
	return { category: "loose-file" };
}
