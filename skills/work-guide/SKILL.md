---
name: work-guide
description: >
  How to get somewhere to work and move the work along
  through the `work` tool: cut a worktree or pin a snapshot,
  make a branch, record a commit, publish it, replay it onto
  a new base, and keep a stack of branches each sitting on
  the one below it. Covers what a snapshot is for against
  what a worktree is for, why a tree is read before it is
  repointed, how a halted replay is settled, and what a
  stacked backend answers better than plain git.
  Use when asked to "get me a worktree", "make a branch",
  "commit that", "push it", "rebase onto main", "the rebase
  stopped", "stack this on top of that", "reorder the
  stack", "restack everything", "what does my stack look
  like", or any request to work on code rather than review
  it. Pairs with review-guide, git-branch-convention,
  commit-format and prose-standard.
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

Never call `git worktree` yourself. A tree cut by hand is one
nothing will clean up, and in the World monorepo the command is
blocked outright.

## Which Tool Cuts the Tree

Two tools can get you a worktree and they are not competing.
The rule is who is going to remember it.

**A quest is loaded: use `quest tree-add`.** The quest records
the tree in its own frontmatter, prunes it on conclude, and
that record is what makes the tree findable next week. `work
tree` records it against this session instead, which is the
wrong lifetime for work a quest owns.

**No quest owns the work: use `work tree`.** Reviewing
somebody else's change, a one-off errand, anything that ends
when the session does.

**Reading rather than editing: use `work snapshot`,** whichever
is true. Quest has no equivalent, because a snapshot is pinned
to a commit and shared between readers rather than owned.

After that the distinction stops mattering. `branch`, `record`,
`push`, `rebase` and every stack verb work on a tree however it
was cut, and quest has none of them. Quest gets you the tree;
this moves the work along inside it.

**Holding one tree means you can stop naming it.** Every action
but `tree`, `snapshot` and `trees` works on a held tree, and
when exactly one is held it is used without being asked for.
Hold two and it becomes a question, naming both: these actions
commit, push and replay, and there is no statement anywhere of
which of the two you meant. An explicit `tree:` is never
second-guessed, so a typo is reported rather than redirected to
whatever else is open.

**A repo it can only reach by remote is refused.** There has to
be a checkout on disk, and if there is not, the refusal names the
missing path rather than fetching one. That is deliberate: cloning
World takes about ten minutes, and a dead end you can read beats a
command that silently spends the afternoon. Pass `checkout:` when
the repo lives somewhere the provider would not guess.

## Reading Before Writing

```
work trees
work status tree:…
```

`trees` lists what is held, and marks any tree left behind by an
earlier session. Read those before touching them: a tree can
hold work this session knows nothing about, and it is listed at
all because a worktree outlives the process that cut it. That
is the point of a worktree, and the reason `release` is a verb
rather than something a session does on its way out.

Run `status` before anything that moves a tree. An untracked file is
work, and overwriting one cannot be undone, so `release` and
any repoint refuse over uncommitted changes rather than
deciding for you.

## Making a Branch

```
work branch tree:… name:fix-410
work branch tree:… name:fix-410 from:main
```

Without `from`, it starts where the tree already points, which
is usually what you want and occasionally not: check `status`
first if you are not sure where that is.

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
work sync tree:… trunk:main       # the daily one
work restack tree:… trunk:main    # when trunk is already current
```

**Reach for `sync`.** It fetches trunk and then replays onto
where it moved to, and it is one verb because doing half of it
is the mistake: restacking without fetching replays the stack
onto a trunk as stale as the one it was already on, reports
success, and leaves everything exactly as behind as it was. It
says whether trunk actually moved, which is what explains why
anything did or did not need replaying.

`trunk` is required for both, for the same reason `onto` is: a
restack replays every tracked branch, so a guessed base
rewrites all of them onto the wrong thing.

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

## After Something Lands

`work tidy tree:… trunk:main` says what has been spent: which
local branches trunk already contains, which of those the stack
still lists and so need untracking too, and whether any
tracking refs point at branches the remote has dropped. Left
undone, those accumulate silently until a branch listing stops
being readable.

It removes nothing. That is deliberate twice over. Deleting a
branch is not undoable, and landing is not an instant: a change
handed to a merge queue merges later and from somewhere else,
so the moment you ask to merge is the moment nothing is
cleanable yet. This is the verb you come back to afterwards.

```bash
work sync tree:… trunk:main    # trunk, then replay what is left
work tidy tree:… trunk:main    # what has been spent, and what has not
git -C <tree> fetch --prune    # drop refs for branches gone from the remote
git -C <tree> branch -d one two three   # delete the merged locals
```

`-d` rather than `-D`: it refuses a branch that is not merged,
which is the check, not an obstacle. If it refuses, the work is
not where you think it is.

One case is left for you on purpose, and it is the one worth
understanding. A branch whose upstream is gone while trunk does
not contain it is exactly what a squash merge produces: the
work landed as a new commit, so git will not call the branch
merged, and the remote branch went away with the merge. It is
also exactly what losing work looks like. Nothing here can tell
those apart, so it is reported as a decision rather than as a
refusal, and clearing it needs `-D`, which throws the commits
away if you guessed wrong.

## Trees Nobody Owns Any More

`tidy` reports leaked trees beside the spent branches, because
they pile up for a reason branches do not. A worktree outlives
the process that cut it, which is the point of one, and it also
outlives a process killed before it could hand the tree back.
The broker's record goes with the process and the directory
stays, so nothing owns the tree, every verb answers "no held
tree", and git still tracks it. Fifteen accumulated in one repo
over four months this way, every one of them cut by an
extension that no longer exists.

`work reclaim tree:… trunk:main` takes those back. It is the
one cleanup verb here that acts, and the asymmetry with `tidy`
is the whole point:

```bash
work tidy tree:… trunk:main       # what is spent, branches and trees
work reclaim tree:… trunk:main    # take back the trees nothing holds
```

Deleting a branch destroys the only name a commit had, so
`tidy` refuses to do it. Removing a worktree destroys a
directory and git's bookkeeping for it and **leaves the branch
exactly where it was**, so the commits stay reachable and
cutting a tree at that branch again puts you back. Recoverable
is what earns a verb the right to act.

It removes only what `tidy` offered, and the two ask one
question so they cannot disagree. A tree the broker still holds
is sent back through `release` instead, since the provider that
cut it knows things about taking it down that this does not. A
dirty tree is refused outright rather than offered as a
judgement call: an uncommitted change exists in one place, and
removing the tree ends it. A tree whose branch trunk does not
contain gets both readings named, the same squash-or-lost-work
call the branch path leaves you.

One tree git will not give up does not strand the ones behind
it. Each is reported on its own line, in git's words, and the
sweep carries on.

## Where This Ends and Review Begins

`work` gets a branch into a state worth showing somebody.
Putting it up, changing it, and landing it belong to
`review_offer`; see the review-guide.

One thing crosses the boundary, and it is worth knowing how.
Mutating a branch that is queued to merge ejects it and
everything speculatively batched with it, and re-running the
checks for the rest is measured in hundreds of jobs. That is a
fact only the hosting layer holds, so `work push` **asks**
before it publishes, and anything that knows a reason to stop
objects in its own words.

An objection comes in one of two strengths, and the difference
is which backend you are on:

- **Blocking.** The backend knows the change is queued. The
  push is refused and says what to do first.
- **A caution.** The backend knows it ejects a queued change
  and cannot tell whether this one is queued. Meteorite is
  exactly this: Merge Garden is a separate service and the pull
  route carries no posture. The push goes ahead and the caution
  is printed beside the result.

A caution rather than a refusal because blocking on a suspicion
would refuse every push on the backend where the hazard is
worst, and a guard that refuses everything is a guard somebody
turns off. Read it and decide: if you did not queue it, you
have lost one line of reading.

The asking is advisory in two more ways:

- Silence means nobody objected, **not** that it is safe. A
  session with no hosting provider loaded has to be able to
  publish.
- A listener that throws, hangs or is missing does not block
  the push, for the same reason.

So treat an objection as reliable and its absence as unproven.
Where the stakes are high and you have seen nothing,
`review_see change` reads the queue state directly.

## When a Backend Knows Better

These verbs are backed by plain git, which is the general
case. A repository driven by a tool that tracks stacks itself
has a better answer than this one does, and a provider there
supplies its own implementation over the bus rather than
teaching this one a second vocabulary. If a stack looks wrong
and the repository is driven by such a tool, suspect two
records of the same thing before suspecting the replay.
