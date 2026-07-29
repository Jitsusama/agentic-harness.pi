# Work

The working layer: branches, commits, trees and stacks. Reviewing
a change and working on one are different jobs, and this library
is the second.

It is deliberately not called `git`. Git is one implementation of
it, and on a stacked workflow the backend that tracks the stack
knows things plain git cannot be asked, so the vocabulary belongs
to the work rather than to one tool that does it.

## What Is Here So Far

| Export | Answers |
|---|---|
| `treeSource` | Where a tree for a change gets cut from |

That is the first half of the trees question, and it is here
before the rest because of what it replaces.

## Why `treeSource` Exists

The review worktree provider used to resolve a source repo like
this:

```ts
join(homedir(), "src", "github.com", owner, repo)
```

That is correct on GitHub and silently wrong everywhere else. A
change on another system resolves to a directory that does not
exist, and the failure surfaces as a missing checkout rather than
as the assumption it really is. A forge name baked into a path is
the hardest kind of assumption to catch, because every test
against that forge passes.

So the question is answered from what the substrate already knows.
A provider that resolved a change has already recorded where its
repo is, locally or by remote, on the `RepoLocator`. A repo it
could say neither about is reported as unplaceable:

```ts
treeSource({ key: "meteorite:shop/world" })
// { kind: "unknown", repoKey: "meteorite:shop/world" }
```

Three outcomes rather than a path or nothing, because the caller
acts differently on each: use it, fetch it first, or say it cannot
be found. Collapsing the last two loses the difference between
work to do and a question to ask.

## Companion Extensions

None yet. The `work` tool that will host this layer arrives with
the rest of the trees facet.
