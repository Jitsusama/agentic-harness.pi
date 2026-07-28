/**
 * Public surface of the review library.
 *
 * One substrate for the activity of reviewing code changes,
 * whatever hosts them and whether anything hosts them at
 * all. A change, its stack, its reviews, its threads and its
 * messages are one neutral model; GitHub, Meteorite, GitLab
 * and a bare git repo are providers behind it.
 *
 * The vocabulary is git's wherever git has a word for the
 * thing: a diff has an old and a new side rather than a left
 * and a right, an anchor names the commit it was formed
 * against, and a stack is refs pointing at refs. Forge
 * inventions stay inside their providers.
 */

export type {
	Anchor,
	AnchorCheck,
	AnchorRefusal,
	DiffSide,
	FileAnchor,
	LineAnchor,
} from "./anchor.js";
export { anchorable } from "./anchor.js";
export type {
	Actor,
	ChangeRef,
	ChangeState,
	Proposal,
	RepoLocator,
	ReviewTarget,
} from "./change.js";
export type {
	DiffFile,
	DiffHunk,
	DiffLine,
	DiffModel,
	DiffStatus,
} from "./diff.js";
export { parseUnifiedDiff } from "./diff.js";
export { changeKey, repoKey, targetKey } from "./keys.js";
