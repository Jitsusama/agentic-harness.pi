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

## A Cargo Tree Starts Warm

A fresh worktree of a Rust workspace has no `target/`, so its
first build compiles every registry crate again and writes
another full copy of them. With several agents each cutting a
tree of the same workspace, that is what fills a disk. So when
`tree` cuts a cargo workspace with no `target/`, it clones the
`target/` of the tree beside it (or the checkout it was cut from)
that built most recently, from the same repository.

The clone is copy-on-write or nothing: `clonefile(2)` on macOS,
which fails rather than falling back to a copy the way `cp -c`
does, and `cp --reflink=always` on Linux. It costs no space until
one side writes. Cargo reuses the registry crates, whose
fingerprints name the registry and not the tree. The workspace's
own packages would not be safe to reuse: cargo hashes a path
package by its place in the workspace, so a sibling's build of the
same member looks fresh here. So every fingerprint of a package
that either tree's `Cargo.lock` records without a source is
removed, and those rebuild. Only the profiles are cloned, without
`incremental/`, the lock or the uplifted binaries. The clone runs
under cargo's lock on the sibling's profiles, skips a sibling
that is mid-build, and is staged beside `target/` and moved into
place, so a failure leaves nothing behind.

On a 58 GiB walgit-rs target the clone took 1.3 seconds and
18 MiB. The first `cargo test -p walgit-wal --no-run` afterwards
compiled 30 packages in 32 seconds: the workspace's own crates,
and the gix family above its `gix-hash` patched from a path.

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
