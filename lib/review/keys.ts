/**
 * Stable keys for repos, changes and review targets.
 *
 * Drafts live on disk and provider bindings stay sticky for
 * the life of a target, so both need a name for "the thing
 * being reviewed" that survives a restart and cannot
 * collide with a different thing. These functions are that
 * name. They are pure, and the shape they produce is a
 * path: slashes separate the parts, and any separator inside
 * a part is folded to a tilde so a part is always exactly
 * one segment.
 */

import type { ChangeRef, RepoLocator, ReviewTarget } from "./change.js";

/** Folds path separators so the value is one path segment. */
function segment(value: string): string {
	return value.replace(/[/\\]/g, "~");
}

/** Stable key for a repo. */
export function repoKey(repo: RepoLocator): string {
	return repo.key;
}

/** Stable key for a hosted change, scoped by provider. */
export function changeKey(ref: ChangeRef): string {
	return [ref.provider, segment(repoKey(ref.repo)), segment(ref.id)].join("/");
}

/**
 * Stable key for anything a review session can look at. The
 * leading part is the target's kind, so a range and a stack
 * over the same refs never collide.
 */
export function targetKey(target: ReviewTarget): string {
	if (target.kind === "proposal") {
		return `proposal/${changeKey(target.change)}`;
	}
	const repo = segment(repoKey(target.repo));
	if (target.kind === "range") {
		const endpoints = `${segment(target.base)}..${segment(target.head)}`;
		return `range/${repo}/${endpoints}`;
	}
	return `stack/${repo}/${target.refs.map(segment).join("+")}`;
}
