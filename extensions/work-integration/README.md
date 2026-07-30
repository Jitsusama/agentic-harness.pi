# Work Integration

Somewhere to work, and knowing what is in it.

Reviewing a change and working on one are different jobs. The
review tools answer the first; this answers the second. It hosts
the tree provider registry for a session, ships the plain-git
provider, and exposes one tool.

## The Tool

`work` takes an action, and defaults to listing what is held.

| Action | What it does |
|---|---|
| `tree` | Cut a worktree, checked out at a branch |
| `snapshot` | Pin a snapshot at a commit, optionally sparse |
| `trees` | List the trees this session holds |
| `release` | Give a tree back |
| `status` | What has changed inside a tree |
| `record` | Stage and commit the work in a tree |
| `branch` | Make a branch in a tree and check it out |

A worktree is checked out at a branch and is yours alone. A
snapshot is pinned to a commit and may be shared with another
reader, because reading does not disturb a reader. Ask for the one
that matches what you are about to do, and always say what it is
for: the purpose names the tree, which is how it is recognised
later and how a second caller avoids cutting a duplicate.

## Why a Provider Registry

The plain-git provider cuts a `git worktree` and is right for
almost every repo. It is not right for a monorepo whose own
tooling knows how to cut a tree from it, and World is that case:
`dev tree` understands sparse zones that a plain worktree of the
whole thing would not.

So providers register over the event bus rather than by importing
the registry, and a specialised one lives in whatever package
owns that knowledge. Selection is by specificity, most specific
first, and it never silently defaults: an unclear choice is
refused with the candidates named.

The handshake runs both ways, as the review substrate's does. This
extension emits `work:ready:v1` when its registry is live and
answers `work:request:v1` for anything that loaded later, because
the bus does not replay and load order between extensions is
nobody's choice.

## What It Will Not Do

**It will not clone.** A repo known only by remote is refused,
with the missing checkout named. Cloning World takes ten minutes
and nobody asked for it, so a dead end that names its input beats
a surprise that spends the time.

**It will not discard your work.** `release` reads the tree first
and refuses while anything is uncommitted, using the same sentence
that guards a repoint. An untracked file counts: overwriting a
modified file is bad and recoverable, and overwriting an untracked
one is neither.

**It will not record nothing.** `record` reads the tree first and
refuses when it is clean. Committing nothing succeeds at the git
level and leaves the caller believing work was saved, which is the
worst kind of success.

**It will not accept a branch name git would take but nothing else
should.** A branch called `-rf` is a valid ref and a flag to every
command that later receives it, so names are checked before git is
called rather than after, and they are refused rather than
corrected. Quietly renaming somebody's branch is worse than
declining to make it.

## What Is Not Here Yet

Stacks. `gs` tracks a stack in a way plain git cannot be asked
about, so that is a facet rather than more actions on this one.
