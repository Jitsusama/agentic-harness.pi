/**
 * Public surface of the tree library.
 *
 * Pluggable working-directory providers. The harness ships
 * a `git-worktree` provider that lives at
 * `<repo>/.worktrees/<name>/`; downstream packages
 * register their own at lower priority numbers to take
 * over for specific repos (e.g. `dev tree` inside
 * `~/world/`).
 *
 * Typical use: the quest workflow calls
 * `resolveTreeProvider(repoRoot)` to pick a provider, then
 * dispatches `create` or `prune` against it. Consumers
 * outside the harness register their own providers via
 * `registerTreeProvider`.
 */

export {
	clearTreeProviders,
	registerBuiltinTreeProviders,
	registerTreeProvider,
	unregisterTreeProvider,
} from "./register.js";
export {
	getTreeProvider,
	listTreeProviders,
	resolveTreeProvider,
} from "./resolve.js";
export type {
	CreateTreeInput,
	PruneTreeInput,
	TreeHandle,
	TreeProvider,
} from "./types.js";
