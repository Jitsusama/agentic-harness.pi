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

import { createHash } from "node:crypto";
import type { ChangeRef, RepoLocator, ReviewTarget } from "./change.ts";

/** The longest file name the filesystems records are kept on take, in bytes. */
const NAME_MAX = 255;

/** How many hex digits of the key's hash a shortened name carries. */
const HASH_DIGITS = 16;

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
 * A change's key as one file name ending in `.json`, holding only
 * letters, digits, dots, dashes and underscores, and no longer than
 * a file name may be once `spare` bytes are added after it (a writer
 * that renames a temporary file into place needs room for its suffix).
 *
 * A name that fits is the key folded, as it always was, so records
 * already on disk keep their names. One that doesn't keeps as much of
 * the front as fits and ends in a hash of the whole key, so two long
 * keys sharing a front still name two files. Without this a range read
 * from a deeply nested tree named a file the filesystem refused, with
 * ENAMETOOLONG, and the round's record was lost (21 Nov, core.nix#6040).
 */
export function changeFileName(change: ChangeRef, spare = 0): string {
	const key = changeKey(change);
	const folded = key.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_");
	const most = NAME_MAX - spare;
	const tail = ".json".length + HASH_DIGITS + 1;
	if (most <= tail) {
		throw new Error(
			`A file name kept ${spare} bytes short of ${NAME_MAX} has no room for a ledger's name, which needs more than ${tail}.`,
		);
	}
	const whole = `${folded}.json`;
	if (whole.length <= most) return whole;
	const hash = createHash("sha256")
		.update(key)
		.digest("hex")
		.slice(0, HASH_DIGITS);
	const front = folded.slice(0, most - tail);
	return `${front}-${hash}.json`;
}

/**
 * Stable key for anything a review session can look at. The
 * leading part is the target's kind, so a range and a stack
 * over the same refs never collide.
 */
export function targetKey(target: ReviewTarget): string {
	if (target.kind === "change") {
		// The kind was once named proposal, and saved review rounds and
		// findings are filed under this key, so the key keeps it.
		return `proposal/${changeKey(target.change)}`;
	}
	const repo = segment(repoKey(target.repo));
	if (target.kind === "range") {
		const endpoints = `${segment(target.base)}..${segment(target.head)}`;
		return `range/${repo}/${endpoints}`;
	}
	return `stack/${repo}/${target.refs.map(segment).join("+")}`;
}
