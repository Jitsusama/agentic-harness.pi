/**
 * Public surface of the tree library.
 *
 * Pluggable working-directory providers. The harness ships
 * a `git-worktree` provider that lives at
 * `<repo>/.worktrees/<name>/`; downstream packages
 * register their own at lower priority numbers to take
 * over for specific repos.
 *
 * Typical use: `quest-workflow` calls
 * `resolveTreeProvider(repoRoot)` to pick a provider, then
 * dispatches `create` or `release` against it. Consumers
 * outside this package register their own providers via
 * `registerTreeProvider`.
 */

export {
	clearTreeProviders,
	registerBuiltinTreeProviders,
	registerTreeProvider,
	unregisterTreeProvider,
} from "./register.ts";
export {
	getTreeProvider,
	listTreeProviders,
	resolveTreeProvider,
} from "./resolve.ts";
export type {
	CreateTreeInput,
	PruneTreeInput,
	ReleaseTreeInput,
	TreeHandle,
	TreeProvider,
	TreeProviderSayingPrune,
} from "./types.ts";
