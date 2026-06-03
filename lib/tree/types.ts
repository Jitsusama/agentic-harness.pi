/**
 * Public types for the tree library.
 *
 * A `TreeProvider` knows how to create and prune a working
 * directory for a stream of code-bearing work. Pluggable
 * per repo root: the built-in `git-worktree` provider
 * handles ordinary git repos at
 * `<repo>/.worktrees/<name>/`; downstream packages
 * register higher-priority providers for the repos they
 * specialise in (e.g. `dev tree` inside `~/world/`).
 */

/** Where the tree lives on disk and what's checked out. */
export interface TreeHandle {
	/** Absolute path to the tree's working directory. */
	path: string;
	/** Branch name checked out at `path`, when known. */
	branch?: string;
	/** Origin repo's root, when the provider knows it. */
	repoRoot?: string;
	/**
	 * Id of the provider that created the tree. Lets the
	 * prune side pick the right provider back up even if
	 * the active provider changed between create and
	 * prune.
	 */
	providerId: string;
}

/** Input for `TreeProvider.create`. */
export interface CreateTreeInput {
	/** Suggested branch/tree name (slug-like). */
	name: string;
	/** Repo root the tree should branch off. */
	repoRoot: string;
	/**
	 * Base branch to branch from. Defaults to the repo's
	 * default branch when omitted.
	 */
	baseBranch?: string;
}

/** Input for `TreeProvider.prune`. */
export interface PruneTreeInput {
	/** Absolute path to the tree to prune. */
	path: string;
	/**
	 * When true, ignore safety checks (dirty working
	 * directory, unmerged branch) and delete anyway. The
	 * quest workflow layers a higher-level safety gate
	 * on top; providers honour this when the gate forwards
	 * the user's "force" answer.
	 */
	force?: boolean;
}

/** A pluggable working-directory provider. */
export interface TreeProvider {
	/** Stable identifier (e.g. "git-worktree", "dev-tree"). */
	id: string;
	/**
	 * Resolution priority. Lower numbers run first; the
	 * first provider whose `appliesTo(repoRoot)` returns
	 * true wins. Built-ins live at 100; downstream
	 * specialisations use smaller numbers to take over.
	 */
	priority: number;
	/**
	 * Returns true when this provider handles the given
	 * repo root. Cheap and synchronous; do filesystem
	 * checks only when they're trivial.
	 */
	appliesTo(repoRoot: string): boolean;
	/** Create a tree. Returns the handle to persist. */
	create(input: CreateTreeInput): Promise<TreeHandle>;
	/**
	 * Prune a tree. Providers throw on safety conflicts
	 * (dirty state, unmerged branch) unless `force` is
	 * true.
	 */
	prune(input: PruneTreeInput): Promise<void>;
	/**
	 * Optional: list trees the provider knows about under
	 * a given repo root. Helpful for reconciling
	 * frontmatter against on-disk state.
	 */
	list?(repoRoot: string): Promise<TreeHandle[]>;
}
