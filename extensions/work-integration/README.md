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
| `carry` | Bundle what a tree couldn't push, with this session, for the share to take home |

A worktree is checked out at a branch and is yours alone. A
snapshot is pinned to a commit and may be shared with another
reader, because reading does not disturb a reader. Ask for the one
that matches what you are about to do, and always say what it is
for: the purpose names the tree, which is how it is recognised
later and how a second caller avoids cutting a duplicate.

What starts from a remote's branch starts from where the remote
has it now, not where the checkout last fetched it: a new branch
made by `branch` from `origin/main`, a tree cut on a new branch
(from its base, or the remote's default branch), and a `rebase`
onto `origin/main`. Each fetches that one branch first, and the
answer names the commit it starts at. Trees cut from a checkout
that had not fetched since a merge came out a merge behind, and
were built and checked on a main that was gone. A fetch that
fails leaves the start as it was and, for `branch` and `rebase`,
says why.

The tool is marked sequential, so pi runs any batch holding a
`work` call one call at a time, in the order written. Side by side,
a resume once read the tree before the `git add` written ahead of
it, and a branch before the `git revert --abort` ahead of it, and
each reported a halt or failure that was gone by the time anyone
looked. A batch with no `work` call in it still runs side by side.

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

## A Tree It Cut Is Trusted

A pi started in a tree the work tool cut, or a folder inside one,
is trusted without pi's folder-trust prompt: this extension answers
pi's `project_trust` yes for any folder its records name, for that
process only, so no decision is saved for a tree that goes. On
2026-11-07 three spawned sessions sat at that prompt in agent-cut
trees until their orchestrator answered it by hand, and Joel ruled
the next morning that such trees are trusted by default. Every
other folder asks as pi always has.

## A Tree Comes With Its Repo's Rules

pi loads AGENTS.md only from the folder a session starts in and
its parents, so a session started in home, or in one repo, that
cuts a tree in another works without that repo's rules. On
2026-11-03 seventeen sessions started in home, builders among
them, and none read core.nix's test pyramid. So `tree` and
`snapshot` (and `quest tree-add` and `tree-adopt`) say the tree's
rules after the tree, when pi loaded none from that repo at the
session's start, once a repo a session. A repo is known by its git
common directory, so every worktree of a checkout is one repo;
rules pi loaded with the same text count as loaded too. A World
tree's rules are read from its one checkout below, `src/`. Rules
up to 16 KB are said whole, as pi would have put them in the
system prompt; past that, as one repo's 422 KB file is, the answer
names the file and asks for it read. The answer adds to what the
model was sent and edits none of it.

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

## Heavy Git Waits Its Turn

The plain-git provider runs git itself rather than through the
bash tool, so its pushes and fetches of World went past the
machine's queue: no walk's slot, no shared slice, and the LFS scan
the queue leaves out of a push that holds no LFS file. From 5
November to the morning of the 6th, 9 of its 16 pushes of World
were stopped by its ten-minute clock, while the queue's that
morning took a median of 29 seconds. Each command it runs is now read as the bash
tool's would be, and one the queue takes runs as the queue's shell,
on a five-hour clock that counts the wait
(`lib/internal/priority/queued-exec.ts`). Everything else runs as
it did.

A push, rebase, resume, restack or sync still running after a minute
moves to a job of kind `work`, as a long bash command does, since on
11 November 21 such calls held their turn, the longest 301 seconds,
while the person's typed lines waited. Its result arrives as a message
of its own. A record never moves: its gate can wait on the person, and
a panel left open behind a job would answer nobody.

## Trees It Did Not Cut

A quest cuts its own trees and records them in its own front
matter, and this broker never sees them. Naming one, by its path
or a path inside it, used to answer that no such tree was held,
so work in quest trees fell back to raw git. The tool now asks
`work:tree-claims:v1` who holds the path, the same question `tidy`
and `reclaim` ask, and acts on the deepest claimed tree that
contains it. It keeps no record of such a tree, and `release`
refuses it with `quest tree-release` as the way back: one owner,
one removal path.

## Trees Whose Sessions Have Ended

Three minutes after a session starts, and every hour after, it
takes back the git worktrees whose recorded sessions have all
ended, by `reclaim`'s rules: clean, and merged into trunk or,
detached, at a commit some ref holds. On 26 October, 185 such trees
sat on one machine, 48 of them reclaimable. It looks again under
the tree's record lock before acting, so a session that took the
tree up since is seen. Under that lock it only moves the tree aside
and forgets its record; the removal comes after. A tree claimed
over `work:tree-claims:v1`, one whose record names nobody, and one
the broker never cut are left alone, and no branch is deleted.
One sweep runs at a time on a machine. Each writes a JSON line to
`sweep.log` in the work state folder.

A tree cut from a clone in a quest's scratch folder outlives the
clone, which goes when the quest concludes or retires, and git can
no longer read it. Once that quest has finished and the tree's
sessions have ended, its folder goes too. A tree whose repository
went any other way is kept.

A tree another provider cut, such as a World dev tree, goes through
that provider's own release, and only once the provider says nothing
would be lost. While it is removed, its record names the sweeping
session, so no other session is handed it. A shareable tree, or one
whose provider can't judge it, is kept. So is one that moved within
a day, its HEAD or, with no git, its folder, and its provider isn't
asked: on 13 November a World tree, clean on its branch, was taken
while the session working on it stood in another folder.

## Dev-Shell Roots Nobody Uses

Entering a tree with direnv roots its flake's dev shell and every
flake input under `.direnv`, and a `nix build` there leaves a
`result` link; each keeps its store paths, and with `keep-outputs`
what built them, from the collector for as long as the tree
stands. On 10 November 1,364 of optimus's GC roots sat in work
trees. So each sweep, held or not, drops a recorded tree's roots
once none was touched in three days and no process stands in it:
nix-direnv's flake inputs and profiles with their `.rc` files, and
the `result` links naming a store path. nix-direnv touches its
roots on every entry, so their age is when the tree was last
entered, and direnv builds the shell again on the next one. The
sweep's log line names each tree and how many went. `tidy` lists
the trees beside a checkout by the roots they hold, saying which
the next sweep drops, and `release` takes them with the tree, since
git removes the ignored `.direnv` with it.

## Carrying a Quest to Another Machine

Joel, 2026-11-07: "how do i take over work from one personal
laptop to another?" `mycelium carry <quest> --to <machine>` does
it, and the harness does the half only it knows how to: what each
session holds, and putting it back on the other side.

Each of the quest's sessions with a pi running or parked is steered
to `carry` (the mesh workflow's README says how it takes that). The
rest goes by `pi-carry`, which mycelium runs once those have
carried:

```sh
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/pi-carry.ts <quest> --to <machine>
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/pi-carry.ts arrive <quest> --from <machine> --session <id>
```

The first carries the quest's sessions nobody closed that no pi
runs, each with the trees the broker's records say it holds, and
then every tree of the quest no done file names yet (those its
README lists here, and those the broker cut for any of its
sessions) under a done file named for the quest. It prints a JSON
line a tree and ends with `{"kind": "done", "files": [...]}`.

Everything goes in the quest's scratch, under
`handover/<this machine>/`, the machine named by its hostname's
short form as mycelium names it (the `carry` action writes there
too). Each session writes `<session id>.done.json` last, whole,
once every file it names is in place:

```json
{
  "session": "<id>", "quest": "<quest>", "cwd": "~/src/app",
  "title": "...", "sessionFile": "<its file, beside it>",
  "trees": [{"path": "~/src/app", "origin": "<url>", "branch": "topic",
             "head": "<commit>", "bundle": "<file>", "needs": [...],
             "patch": "<file>"}]
}
```

Paths are within home, since the other machine's home is
elsewhere. `bundle` holds the commits no remote has and is absent
when a remote has them all; `needs` names what a remote holds that
the tree needs first, each commit with the remote branch it was on
(with no bundle, the head itself). `patch` holds every change never
committed, untracked files included, made from a copy of the tree's
index so the tree's own index and files are never touched, and is
absent when it was clean. A tree on no branch is passed over when
it's clean at a commit a remote has, and refused otherwise; the
rest still go. The quest's own done file holds trees only.

`pi-carry arrive` runs on the machine the quest went to, before
`pi --session <id>`. It waits up to ten minutes for the done file
and every file it names, since the share may land late, saying
`{"kind": "waiting", ...}` each half minute. Then each tree is
cloned from its origin where nothing is, or fetched where it
stands with that origin and nothing changed, given what it needs
from the remotes named, the bundle's commits, its branch at its
head and its patch; one line each, `{"kind": "tree", "path",
"branch", "did": "cloned" | "fetched" | "refused", "why"?}`. A
folder with another origin or changes of its own, or a branch
holding commits the carried one lacks, is refused, never written
over; a tree that already stands as carried is left as it is. The
session's file is placed where pi finds it from its folder here,
over any older copy, and it ends with `{"kind": "sessions",
"sessions": [{"id", "cwd"}]}`. It exits 1 when a tree was refused
or nothing came, so nothing starts half arrived, and 2 when it was
asked wrongly.

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
