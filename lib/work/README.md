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
| `chooseTreeProvider` | Which provider serves a repo |
| `createTreeBroker` | Custody: hand trees out, take them back |
| `createGitTreeProvider` | The general case, backed by `git worktree` |

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

## Specificity, Not Priority

Providers declare how *specific* they are, and more specific wins.
That wording is doing real work. The two brokers this replaces
sorted in opposite directions:

| Broker | Order | Built-in at | Downstream declared |
|---|---|---|---|
| `lib/tree` | smallest first | 100 | `PROVIDER_PRIORITY = 50` |
| pr-workflow worktrees | largest first | 0 | `PROVIDER_PRIORITY = 100` |

Both downstream World providers were correct under their own
broker, holding the same constant name at two values that meant
opposite things. Unifying on either direction would have silently
inverted one, and silently is the operative word: losing raises
nothing, because the general provider still produces a tree. It
would just be a plain git worktree where a `dev tree` was wanted,
which works well enough to go unnoticed.

"Priority" reads both ways in English, since priority 1 can mean
first or last. "Specificity" does not: a provider for one repo is
plainly narrower than one for any repo. A provider serving
everything declares 0.

## A Tie Is Reported, Not Resolved

Two providers claiming one repo at the same specificity is a
configuration mistake. Settling it by registration order hides the
mistake behind a tree that looks fine, so the choice comes back as
`ambiguous` with both contenders named, in a stable order so the
same mistake reads the same way every time.

A tie *below* the winner is not a tie at all and is ignored.

## The Broker Is Only Custody

The broker is what made three tree contracts look like three
problems. Each held its own trees, keyed them its own way, and
reimplemented the same two questions: does one of these already
answer the request, and who serves this repo.

Both questions now have one answer each, in `tree.ts` and
`provider.ts`, so what is left is genuinely just custody. It
refuses rather than guessing when the provider choice is unclear,
because cutting a tree from a provider nobody chose *succeeds*, and
the tree is merely wrong rather than missing.

A held tree records who cut it. The chosen provider can change
between cutting and releasing, since registration is dynamic, and a
tree has to go back to whoever made it rather than to whoever would
be chosen now.

## The Built-In Provider Does Not Clone

`createGitTreeProvider` serves any repo with a checkout on disk,
detaching at a commit for a snapshot or checking out the branch for
a worktree. It runs against the checkout the substrate already
found, via `git -C`, never a path derived from the repo key.

A repo known only by a remote is refused with the remote named:

```
github:Shopify/world is known only as https://github.com/Shopify/world.git,
and cloning a repo you did not ask for can take a very long time.
Clone it yourself, or register a provider that knows this repo.
```

Cloning an unasked-for repo can be enormous, and quietly spending
ten minutes on one is a surprising thing for a tool to do. Saying
what is needed leaves the choice with whoever knows how big it is,
and a downstream provider that knows a particular repo can serve it
without asking.

## Companion Extensions

None yet. The `work` tool that will host this layer arrives with
the provider contract and the broker.
