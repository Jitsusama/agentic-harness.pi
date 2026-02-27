---
name: rebase-resolution
description: >
  Resolving rebase conflicts with design intent preservation.
  Use when rebasing, resolving merge conflicts, or discussing
  conflict resolution strategy.
---

# Rebase Resolution

Think of rebasing as archaeology meets architecture: understand
why each change was made, then design a result that incorporates
both visions.

## The Three Questions

For every conflict, ask:

1. What problem was each side solving?
2. Which solution is architecturally superior?
3. How can both intents be preserved?

## Conflict Types

**Same problem, different solutions** — both sides fixed the
same thing differently. Combine the best aspects of each.

**Parallel features** — both sides added different capabilities
to the same area. Accommodate both.

**Architectural divergence** — one side refactored while the
other added features. Adapt the features to the new structure.

**Performance vs capability** — one side optimized, the other
extended. Preserve the features within the performance gains.

## Resolution Principles

- **Architecture wins over implementation** — if the target
  branch has better structure, adapt to it. Don't preserve
  bad patterns just because they work.
- **Features are sacred** — never silently lose functionality.
  Find a new home for features in the evolved architecture.
- **Consistency trumps cleverness** — follow the patterns
  already established. Don't introduce new ones mid-rebase.
- **Quality over speed** — choose the better design, not the
  easier merge.

## Verification

After each conflict resolution:

- Do the tests pass?
- Does the code compile / lint clean?
- Is any functionality missing compared to before?

Run the full suite after the rebase completes. Never push
until everything passes.

## Pushing

- Always use `--force-with-lease`, never `--force`
- Show the final state before pushing — the user confirms
- If tests fail after rebase, abort and reassess rather than
  pushing broken code

## When to Abort

- The same conflict keeps recurring after resolution
- Test failures indicate fundamental incompatibility
- The commits need reordering (requires a different approach)
- A conflict is too complex to resolve cleanly — discuss first
