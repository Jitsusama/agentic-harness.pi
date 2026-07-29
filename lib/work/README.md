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
| `treeIdentity` | What tree a request is asking for |
| `satisfies` | Whether a tree already held answers a request |

These are here before the council moves across, because the
council cannot become provider-agnostic while it is asking a
forge-shaped question.

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

## Two Lifecycles, Not Three

There were three tree contracts: the review worktrees keyed by
commit, the fix worktrees keyed by pull request, and the quest
trees keyed by a name a person chose. Reading them side by side,
the fix and quest cases differ only in what names them. Both are a
durable branch you edit in.

What actually varies is what the tree is pinned to, and that is
what changes the reuse rule:

| Intent | Pinned to | Edited in | Shared |
|---|---|---|---|
| `snapshot` | a commit | no | yes, between readers |
| `worktree` | a branch | yes | no, one stream of work |

A worktree's identity deliberately leaves the commit out. The
branch moves under it every time you commit, so an identity that
moved with `HEAD` would orphan the tree you are working in on your
first commit.

A snapshot's `paths` are left out too. Narrowing what gets
materialized is a provider's optimisation, not part of what the
tree is, and folding it in would fragment reuse per distinct file
set.

`shareable` rides on the identity rather than being a caller's
judgement call, because whether handing one tree to two callers is
safe follows from the intent and nothing else.

## Companion Extensions

None yet. The `work` tool that will host this layer arrives with
the provider contract and the broker.
