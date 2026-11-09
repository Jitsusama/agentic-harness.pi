# Tree Internals

Where `lib/core/tree` keeps its providers: the process-global
registry of tree providers, shared with other packages' copies of
the harness, and the built-in providers it is seeded with. The
contract, and choosing a provider for a repo, stay in that module.

## Folders

- `providers/`: the built-in git-worktree provider, which makes
  trees at `<repo>/.worktrees/<name>/` in any git repo, for a
  downstream provider to take over in the repos it knows.
