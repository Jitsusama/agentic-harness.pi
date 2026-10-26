/**
 * Public API for the `attribution` domain: making AI involvement
 * in commits, PRs and issues transparent, however a host chooses
 * to realize it. Two genuinely different mechanisms live here
 * because the one thing that differs per adapter (how a commit
 * gets marked as AI-driven, given each host's own capabilities)
 * is a real port (`CommitHookOptions`), not a reflexive one.
 */

export {
	buildPrepareCommitMsgHook,
	type CommitHookOptions,
	ensureCommitHook,
	type HookInstall,
	installCommitHook,
	repoRootOf,
} from "./commit-hook.ts";
export { type GhFooterInsertion, insertGhBodyFooter } from "./gh-footer.ts";
export { formatModelName } from "./model-name.ts";
