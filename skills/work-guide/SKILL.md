---
name: work-guide
description: >
  How to get somewhere to work and move the work along
  through the `work` tool: cut a worktree or pin a snapshot,
  make a branch, record a commit, publish it, replay it onto
  a new base, and keep a stack of branches each sitting on
  the one below it. Covers what a snapshot is for and what a
  worktree is for, why a tree is read before it is repointed,
  the boundary that stops a restack duplicating commits, how
  a halted replay is settled, and which of these a stacked
  backend answers better than plain git does.
  Use when asked to "get me a worktree", "cut a tree for
  this", "make a branch", "commit that", "push it",
  "rebase onto main", "the rebase stopped", "stack this on
  top of that", "reorder the stack", "restack everything",
  "what does my stack look like", or any request to work on
  code rather than to review it.
  Pairs with review-guide for putting the work up once it is
  ready, git-branch-convention for naming, commit-format for
  the message, and prose-standard for voice.
---

# Working on Code

The `work` tool answers two questions: where do I work, and
what happens to the work. Reviewing a change and working on
one are different jobs, and this is the second.

Everything is scoped to a tree. Ask for one first, then every
later verb names it.

## Getting Somewhere to Work

Two kinds of place, and the difference is what the tree is
pinned to rather than how long it lives.

| Ask for | When | Pinned to |
|---|---|---|
| `tree` | You are going to edit | A branch |
| `snapshot` | You are going to read | A commit |

A worktree is exclusive to one stream of work, because two
people editing one directory is not a workflow. A snapshot is
shareable between readers, since nothing is going to change
under them.

Always say what the tree is for. The purpose names it, which
is how it is recognised later and how a second caller avoids
cutting a duplicate of one that already exists.

```
work tree repo:github:Shopify/world branch:main purpose:"fix-410"
work snapshot repo:github:Shopify/world commit:abc1234 purpose:"read-410"
work trees          # what this session holds
work release tree:…  # give one back
```

Never call `git worktree` yourself. A tree cut outside the
broker is one nothing will clean up, and in the World monorepo
the command is blocked outright.

## Reading Before Writing

`status` before anything that moves a tree. An untracked file
is work, and overwriting one cannot be undone, so `release`
and any repoint refuse over uncommitted changes rather than
deciding for you.

## Recording and Publishing

```
work record tree:… subject:"fix(auth): stop double-charging" body:"…"
work push tree:…
```

`record` stages and commits. `push` publishes, and two rules
are built in rather than offered:

- **The first push sets upstream.** A branch without one has
  to be told its own name every time and is eventually told
  the wrong one.
- **A replacing push is always a lease.** Pass `replace:true`
  after a rebase and it is refused if the remote moved since
  this tree last fetched, rather than overwriting whatever
  arrived. A refused lease means work landed: fetch, look at
  it, then push again.

A push that changed nothing says so. Do not read that as a
failure, and do not read it as success either: the commit you
expected to publish may never have been made.

## Replaying One Branch

```
work rebase tree:… onto:main
```

`onto` is required. A rebase has no sensible default, because
replaying onto the wrong base rewrites every commit on the
branch.

Uncommitted work is refused rather than stashed. Git's own
autostash would hide the problem, and moving somebody's
changes is not a decision to take quietly.

### When It Halts

A conflict is a **halt**, not a failure. The tree is neither
where it was nor where it was going, and the answer names the
commit it stopped on and the paths that disagree.

Two ways out, and no third:

```
work resume tree:…    # once the conflicts are resolved
work abandon tree:…   # put the tree back where it started
```

`resume` refuses while anything is still unmerged, so resolve
first. Starting a second replay over a halted one is refused
by name rather than making the state worse.

## Keeping a Stack

A stack is branches each sitting on the one below it. **Git
does not track this**, so it is recorded, in git's own config
under the branch it describes. That means anybody can read it
with `git config`, and git deletes it when the branch goes.

```
work track tree:… name:base-work           # a root, sitting on trunk
work track tree:… name:next-bit onto:base-work
work stack tree:…                          # what sits on what
```

`stack` draws the shape, because a flat list of branch names
has thrown away the only thing that makes it a stack.

### Moving Things Around

```
work reparent tree:… name:next-bit onto:something-else
work reorder tree:… order:["base-work","next-bit"]
work untrack tree:… name:base-work
```

`reorder` takes the order **you** want, lowest first. Nothing
here can work out an order you have not stated: a stack lives
in whatever tracks parentage, and inferring one is a guess
dressed as a fact.

Name every branch above the lowest one you are moving. A
partial order would leave a branch sitting on something that
moved out from under it, which is a broken stack presented as
a finished job, so it is refused instead.

`untrack` moves whatever sat on the branch down onto its
parent, so removing one member does not break the rest.

### The Thing To Understand About Reordering

**A reorder moves the record. Only a restack moves the
commits.** The tool says so every time, and it matters: a
stack whose record and commits disagree looks correct in a
listing and is wrong in the repository.

```
work restack tree:… trunk:main
```

`trunk` is required for the same reason `onto` is: a restack
replays every tracked branch, so a guessed base rewrites all
of them onto the wrong thing.

A restack replays in order, roots first, and each branch from
the base it was last aligned at. That boundary is what
separates a branch's own commits from its parent's; without
it every branch is handed copies of everything below it, and
that is the mess that makes people abandon stacks.

It **stops at the first halt** and says what it never reached.
Settle the halt, resume, then restack again to carry on up.
It also puts you back on the branch you started on.

Running it twice is a no-op. If a second run replays anything,
something moved underneath you, and that is worth knowing
rather than shrugging at.

## Where This Ends and Review Begins

`work` gets a branch into a state worth showing somebody.
Putting it up, changing it, and landing it belong to
`review_offer`; see the review-guide.

One seam is worth stating because it will bite. `work push`
cannot refuse while a change is queued to merge. Queue state
lives on the review contract and the working layer has no
route to it, so on a backend with a merge queue, check with
`review_see change` before pushing to a branch that is
enqueued. Mutating an enqueued branch ejects it and everything
batched with it.

## When a Backend Knows Better

These verbs are backed by plain git, which is the general
case. A repository driven by a tool that tracks stacks itself
has a better answer than this one does, and a provider there
supplies its own implementation over the bus rather than
teaching this one a second vocabulary. If a stack looks wrong
and the repository is driven by such a tool, suspect two
records of the same thing before suspecting the replay.
