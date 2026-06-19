import type { WorktreeHandle } from "./worktree.js";

/** Outcome of resolving a sha (or prefix) to one review worktree. */
export type WorktreeSelection =
	| { status: "found"; handle: WorktreeHandle }
	| { status: "missing" }
	| { status: "ambiguous"; matches: WorktreeHandle[] };

/**
 * Resolve a sha to a single worktree handle. An exact sha
 * match wins outright; otherwise a sha that the input is a
 * prefix of matches, and a prefix that hits more than one tree
 * is reported as ambiguous rather than guessed.
 */
export function selectWorktreeBySha(
	handles: readonly WorktreeHandle[],
	sha: string,
): WorktreeSelection {
	const needle = sha.trim();
	if (needle === "") return { status: "missing" };

	const exact = handles.find((handle) => handle.sha === needle);
	if (exact) return { status: "found", handle: exact };

	const matches = handles.filter((handle) => handle.sha.startsWith(needle));
	if (matches.length === 0) return { status: "missing" };
	if (matches.length === 1) return { status: "found", handle: matches[0] };
	return { status: "ambiguous", matches };
}
