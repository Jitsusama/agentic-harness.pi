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

Asked for a branch the tree is already on, as `tree` made it, from a
remote's branch, `branch` moves it up to the fresh start by a fast
forward, when every commit on it is in that start. Staged and unstaged
changes come along, and one the start would overwrite stops the move
with nothing changed. A start that isn't a remote's branch moves
nothing. On 19
November a World tree's branch, made at a stale main, could never
reach the fresh one, since git refused a branch that already existed.
A branch with commits of its own is left where it is, and the answer
says to rebase.

A `rebase` replays only the branch's own commits. When it can, it
judges them by the remote's trunk, fetched first unless it was
fetched lately. A commit that is already on trunk stays there, and
the answer counts the commits it left off rather than carrying them
as the branch's own. Early on 23 November a core.nix branch with no
commits of its own, sitting on a merge trunk held, was rebased onto
a base that held only copies of that merge's commits. It came back
with 8 commits replayed on top, undoing trunk's later edits to 8
files. A base
the branch already holds answers that there is nothing to replay.
A base git doesn't know is named before anything else is asked.
When git can't say which commits are trunk's, the rebase is
refused and nothing is replayed. With no remote trunk to judge
by, every commit the base lacks is replayed, and the answer says
so. `restack` still replays each branch as git does; it isn't
judged by trunk.

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

The push runs through that same git. Until 20 November it ran on
the ten-minute clock of its own, so it never reached the queue, and
that clock counted the wait at World's push gate, a hook that holds
a push for up to 30 minutes while another runs. Five pushes queued
at the gate behind one that hung for 25 minutes timed out before
their turn came. A push the queue doesn't take now runs on a clock
that stands still from the gate's line saying it waits its turn to
the line saying its turn came, with 35 minutes for all its waits
together (`lib/core/exec/clock.ts`). Only a line that starts with
the gate's name holds it, so a remote's `remote: ` line holds none.

This git is held to the folders it may run in (`tree-git.ts`)
before the queue takes it, since the queue runs it as a shell line
the guard would let by: a queued push of a tree whose `.git` a
sandboxed command pointed elsewhere is refused, not run.

A branch, push, rebase, resume, restack or sync still running after a
minute moves to a job of kind `work`, as a long bash command does,
since on 11 November 21 such calls held their turn, the longest 301
seconds, while the person's typed lines waited. A branch joined them
on 19 November, when its fetch of World's main held a turn for two
minutes. Its result arrives as a message
of its own. A record never moves: its gate can wait on the person, and
a panel left open behind a job would answer nobody.

A checkout's fetches follow the package config's `work` section, keyed
by the checkout's git folder (`lib/core/work/fetch-rules.ts`):

```json
{
  "sections": {
    "work": {
      "fetches": {
        "/home/someone/world/git": {
          "prefetched": true,
          "through": "a-call-is-on && exit 75; exec world-push-turn 1 \"${PI_QUEST:-work}\" --"
        }
      }
    }
  }
}
```

With `prefetched`, a fetch of a remote's branch moves its tracking ref
forward to what `refs/prefetch/remotes/` holds, and a fetch naming no
ref is answered by the prefetch, so none reaches the remote. A ref
already ahead stays. A fetch the prefetch can't answer runs behind
`through`, given git and its words as `"$@"`, inside the guard and the
queue: one of a commit by its id, of a branch the prefetch lacks or
that a force push moved off the ref's line, of a remote nothing was
prefetched of, with an option other than `--quiet`, `--no-tags` or
`--no-write-fetch-head`, or one whose move git refused. A tree, a
branch, a rebase and a sync fetch through this git too, not only a
snapshot. On 24 November two snapshots of World each fetched 5.4 GB at
once outside every turn. A checkout the section doesn't name fetches as
it always did, since git's maintenance writes `refs/prefetch` in
repositories nobody promises to keep fetched. The folder is matched as
written or through its links.

The prefetch doesn't run during a call, so an answered start can be
that far behind origin; the move isn't logged as a fetch, so a start
that trusts a recent fetch asks again rather than trust a prefetch of
unknown age. A short id merged since the last prefetch isn't found, and
the refusal says to give its full id. A branch's or a replay's fetch
runs on its three-minute clock in the queue too, waits for a turn
included, and past it starts from what it has.

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

A tree standing where the broker cuts them that git won't read
is stranded: one cut from a clone the fence doesn't guard, or
whose git folder is gone. No checkout's git lists one cut from
such a clone, and every cut at its name died on git's bare
`already exists`, as a snapshot a host restart left on 20
November did. Release can't run git there either, so a session
releasing one in the work tool's own trees folder has it set
aside whole, as reclaim sets one, without reading it. Unlike
reclaim, release doesn't ask whether a process still works in it:
the release is the session's own word that it's done. While
another session holds it too, it stays where it is for that one,
and only this session's hold goes; one whose git entry is locked
by hand stays, as reclaim leaves it. A tree outside that folder
is left to whatever cut it.
Cutting at its name now refuses, naming the tree and the way out
that fits it. `tidy` lists each one no running session
holds, counted apart from the checkout's own trees, and
`reclaim` moves it aside whole to `work/stranded/`, since git
can't say whether it holds work. They are asked about again,
once for all, just before they move, and one with a record moves
only under that record's lock, as the sweep takes a tree. One a
process works in, one git has marked locked within the hour, and
one whose `.git` is under ten minutes old, as a cut still running
may be, stays; where the machine can't say what works in a
folder, every one stays (`lib/core/work/stranded.ts`). The
guard's own words for its refusal are never said back, since a
fenced command can choose the path in them. A tree set aside
keeps its `.git` as `.git-was`, parted from git's entry, which a
tree cut again at its name takes back. Cutting again from the
clone that cut a tree set aside forgets git's entry for that one
gone folder, a lock on it included once it is an hour old, and
tries once more; the clone's other entries stay for git's prune.
A lock `git worktree lock` left, or a cut killed before git was
told English, is never forgotten, so reclaim leaves that tree
where it is until it is unlocked from the clone that cut it. Nothing here
runs git in a tree set aside, nor should a person: a command in
the sandbox may have written the settings and hooks git, or a
repository inside it, would run.

## Trees Whose Sessions Have Ended

When a session starts in a pi host, the records of the trees it holds
are made to name the process it runs in now. After a host restart they named the
old one, and the disk guard, which judges a tree by its owners, took
the node_modules of a tree a resumed session was working in.

Three minutes after a session starts, and every hour after, it
takes back the git worktrees whose recorded sessions have all
ended, by `reclaim`'s rules: clean, and merged into trunk or,
detached, at a commit some ref holds. On 26 October, 185 such trees
sat on one machine, 48 of them reclaimable. In the outside runner, a
clean tree on a branch also goes when its HEAD is the head of a pull
request GitHub merged into trunk, read once a repository from the
newest thousand, since a squash merge leaves trunk without the
branch's commits and GitHub then deletes the branch: on 25 November
one machine kept 169 trees as squash merges or only copies, and 448
worktrees sat at such a head. Under the tree's record lock, just
before the move, who works there is asked again and HEAD and branch
are read again; each such take but the first waits the runner's
pause, and the branch stays. A repository gh can't list is named in
the log line's `unlisted`, and its trees kept as before. Hosts list
nothing, as the listing goes over the network with the lock held. A
snapshot also goes
when it is clean and its HEAD never left the commit its record says
it was cut at, whatever holds that commit: on 18 November one
machine kept 746 ended snapshots, 25 GiB, most at a pull request's
head from before a rebase. Its HEAD's reflog must name only that
commit, since a commit made there and then left is held by that
reflog alone. Files the commit under review tells git to ignore go
with it, as build output does. It looks again under the tree's
record lock before acting, so a session that took the tree up since
is seen. Under that lock it only moves the tree aside and forgets
its record; the removal comes after. A lock another process holds
past the wait keeps that tree alone, saying so, and the log line
names up to ten such trees with their lock and pid, rather than end
the run: on 22 November a live session holding a snapshot's record
lock past 10 s on a loaded machine failed a whole run 40 minutes in,
and it logged none of what it took. The move is a rename that points
git's own folder for the tree at its new place, as git's move does, so pi's
guarded git still runs there and a tree cut at the old place gets a
folder of its own. The removal takes the tree and that folder, after
the checks git's remove makes: not locked, no submodule, nothing
`git status` lists, untracked files included. The folder must be one
of the repository's own, since a tree's `.git` file is anybody's to
write who ran in it.
Git's move and remove read every worktree the repository has, which
with 2,061 cost 29 s and 19 s a take, so a run took 20 of 1,800.
Dropping a merged branch with `git branch -D` still reads them all,
but that cost 0.27 s with 1,130, and detached snapshots, most of
what a sweep takes, have no branch to drop.
A tree claimed
over `work:tree-claims:v1` for good, one whose record names nobody,
and one the broker never cut are left alone; one claimed only until
spent goes by the rules above once its sessions end, and by the idle
rules below only as they say. The outside runner alone also
finishes up to ten removals a run that stopped part way: folders named
as cut trees with no `.git` at their top or just below, which no record
or claim names, reaches into or holds from above, untouched for a day
in their top two levels, and in which nothing works just before each
is moved. A taken tree's branch stays,
unless origin's trunk holds every commit on it, as on release; a
branch kept for a live session's taken worktree stays regardless,
as below.
One sweep runs at a time on a machine, and none starts within 20
minutes of one ending, told by `sweep.lock.ended` beside the lock:
each session sweeps on its own timer, and on 18 November about 120
of them kept one sweep or another running without a break. The
outside runner alone waits up to half an hour, looking every ten
seconds, for another sweep to end, where a host's sweep stands down
at once: on 25 November its 09:00 and 10:00 runs stood down in about
20 s, so the removals only it finishes waited. Its line says how long
it waited in `waitedMs`. Each
sweep writes a JSON line to `sweep.log` in the work state folder,
but for one that rested. One that found another running says so,
as the sign of a sweep that holds the lock and never ends.

A sweep asks git's status only of the trees it could take, one at a
time, never of the other worktrees beside them: on 25 November it
asked about 2,000 an hour, eight at once, while Joel's browser
waited on the disk. A tree git said was dirty, whose HEAD, branch,
index and top folder are as they were at the last sweep, is answered
from what git said then, kept in `sweep-status.json` beside the log,
for at most a day. An edit, or a file added or removed below the top
folder, changes none of those, so a remembered answer can be stale,
and only a dirty one is kept: it can keep a tree a day longer, never
offer one. A tree that reads clean is asked each sweep, so no take
begins on a stale answer. Only a sweep that ran saves, never one that
rested or found another running.

A session that joins a snapshot as a sweep takes it finds it gone
once its own claim is written, and cuts it afresh.

A snapshot a session still open holds goes too, once nothing has
used it for four hours: clean, with no untracked file, at its pin,
not locked and holding no submodules. Its use is the latest of its
record's own file, which every ask rewrites on any version of this
code, the record's date, git's HEAD, index and log, and the folder.
A claimed snapshot, or one a process works in, runs from or holds a
file open in, is kept. That reading comes from `/proc`, before
choosing and again for each under its record's lock, and only from
the machine's own process namespace; where it can't be read, or a
process's files can't for a reason other than permission, nothing is
taken, and the sweep's line says why in `idleUnjudged`. A reader that
opens files by path and keeps none open leaves no sign, so four hours
is its protection. At most 20 go a sweep, oldest first, each logged
with its sessions and commit; the sweep outside the hosts takes up to
200, each judged only once the one before is taken, pausing 2 seconds
between takes, and starts judging no more past its first 20 once 10
minutes have gone since it reached them, the ended trees before them
not counted. A run its count or time stops gives in `idleLeft` how
many it left unjudged, those seen busy aside, though judging may
refuse some of them, and every run that reaches them gives in `idleMs`
how long they took, its census of processes, its pauses and the dating
of every live snapshot included.

A worktree a session still open holds goes too, once nothing has used
it for a day, by the same signs of use and the same reading of
processes, and only with nothing found only there: on a branch, its
head on a remote-tracking branch, no change, untracked file or ignored
file beyond what builds make again (ignored links, as Nix's `result`,
and ignored folders builds name, as `node_modules/` and `target/`; any
other ignored folder, as `.worktrees/`, may hold work), no file marked
skip-worktree or assume-unchanged, no stash on its branch, no commit
only its HEAD's reflog holds, not locked and no submodules. One a
holder claims stays, unless it claims it only until spent and some
holder names it in `idleMayTake`, one list for them all: a live quest
names there each tree it lists on this machine in a known repository
but that repository's last whose folder stands, and never one any
live quest keeps, so the tree its session reopens in stays. A run
whose ended trees took or refused one a holder kept from these rules
asks the holders again, since they chose before that tree went, and
the rules take only what both answers name; a holder that can't be
asked again lets them take none it claims. A taken tree leaves its
quest's list, but its branch's alias stays while the branch does, so
a change on that branch still finds the quest, and goes once a sweep
deletes the branch. One whose record names no
session stays, as nothing could tell or keep its
branch for it. Worktrees go first, with half the share, so a backlog
of snapshots never starves them, and `idleWorktreesLeft` says how many
a run left.
Before one goes a note in `kept-branches/`, beside the lock, keeps its
branch at its head while any session it names lives, written aside and
renamed in, and taken back if the tree stays where it was; a second
take of the branch adds its sessions. Under the record's lock all of
it is read again, branch and head included. The work tool's listing
names each branch taken from the session first, at its head, until
that branch is checked out at its path again, when its note goes too;
asking for the branch checks out the same branch and head.
`idleMs` is awake time, which stops while the machine sleeps, and the
line's `ms` is wall time. Without a suspend, `ms` less `idleMs` is the
rest of the run: before the idle snapshots, the claims, the census of
trees in use, the ended trees, the stopped removals and the
settled-branch search, and after them, the other providers' trees and
the dev shells' roots; across a
suspend, it isn't even that. A session that asks for one again gets
it cut afresh, with a line in `sweep.log` saying why.

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
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/pi-carry.ts settle <quest> --session <id>
```

The first carries the quest's sessions nobody closed that no pi
runs, each with the trees the broker's records say it holds,
leaving out any a later session continued (another log names its
log as the parent) or whose pi died before a turn of its own. It
then carries every tree of the quest no done file names yet (those its
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
             "patch": "<file>"}],
  "fence": "none" | "fence" | "strict",
  "notes": [{"text": "...", "tags": [...], "source": "..."}]
}
```

Paths are within home, since the other machine's home is
elsewhere. `bundle` holds the commits no remote has and is absent
when a remote has them all; `needs` names what a remote holds that
the tree needs first, each commit with the remote branch it was on
(with no bundle, the head itself). `patch` holds every change never
committed, untracked files included, made from a copy of the tree's
index so the tree's own index and files are never touched, and is
absent when it was clean. A tree on no branch, or one gone from
the machine, is passed over, its files left where they are; one
git can't read as a tree of its own is refused; the rest still go.
`fence` is how the session's commands were fenced (its
`PI_SANDBOX`), and `notes` are its quest's remembered facts,
which live in each machine's own memory store; older harnesses
leave both out. The quest's own done file holds trees only.

`pi-carry arrive` runs on the machine the quest went to, before
`pi --session <id>`. It waits up to ten minutes for the done file
and every file it names, since the share may land late, saying
`{"kind": "waiting", ...}` each half minute. Then each tree is
cloned where nothing is, or fetched where it stands with that
origin and nothing changed, given what it needs from the remotes
named, the bundle's commits, its branch at its head and its patch;
one line each, `{"kind": "tree", "path",
"branch", "did": "cloned" | "fetched" | "refused", "why"?}`. A
folder with another origin or changes of its own, or a branch
holding commits the carried one lacks, is refused, never written
over; a tree that already stands as carried is left as it is. Each
note the memory store here lacks for the quest, judged by its text,
is added, so arriving twice adds nothing. The session's file is
placed where pi finds it from its folder here, over any older copy,
and it ends with `{"kind": "sessions", "sessions": [{"id", "cwd"}],
"fence"}`, the fence naming what the session ran under; the node
starts pi under that one, never another. It exits 1 when a tree was
refused, the notes couldn't be added or nothing came, so nothing
starts half arrived, and 64 when it was asked wrongly.

A tree is cloned from a twin, a repository near where it goes with
the same origin that is neither shallow nor partial, with
`--shared`, so it borrows the twin's objects and writes nothing
into it; its origin is then set to the carried one, and what it
needs comes from there one branch at a time. Only with no twin is
the origin cloned whole. A tree cloned here takes the sparse
checkout it left in. Each arrival writes every line it said, and
whether it came whole, to `arrivals/<session>.json` in the quest's
scratch, since a held start's output ends with its hold.

`pi-carry settle` lets the old place go, on the machine the session
left. The node runs it once the arrival is confirmed and the carry
has passed the launcher's Carried day, so a Carry Back within the day
finds its trees whole. Each worktree the done file names goes, by
`git worktree remove`, which keeps its branch, only when it is on the
branch carried, at the commit carried, with uncommitted changes byte
for byte the patch that went; files git ignores go with it, as the
carry left them out. One holding anything since keeps every tree,
named with why, as does one a live session holds by the broker's
record or any process works inside, since a quest's sessions share
its trees, and a pi running the session here again. A tree let go
leaves the broker's records too. A
checkout of its own stays, being the person's. One line a tree,
`{"kind": "tree", "path", "did": "let go" | "gone" | "stays" |
"kept", "why"?}`, then `{"kind": "settled", "session", "let"}`. It
exits 1 when it kept them, and settling again finds each tree gone
and settles.

## What It Will Not Do

**It will not clone.** A repo known only by remote is refused,
with the missing checkout named. Cloning World takes ten minutes
and nobody asked for it, so a dead end that names its input beats
a surprise that spends the time.

**It will not discard your work.** `release` reads the tree first
and refuses while anything is uncommitted, using the same sentence
that guards a repoint. An untracked file counts: overwriting a
modified file is bad and recoverable, and overwriting an untracked
one is neither. A tree git won't run in can't be read, so it is
set aside whole with everything in it rather than removed. Its
branch stays, but git's entry for it, with its index and HEAD, goes
when the clone that cut it next cuts that name, or at `git worktree
prune` there. A snapshot was on no branch, so whatever was committed
in it hangs only from that entry's HEAD: give it a branch from the
clone before then. A tree whose `.git` became a repository of its
own, or a link to one inside the tree, keeps what was committed
there only in what was set aside, and the answer says so. Run no git in what was
set aside: a command in the sandbox may have written the settings and
hooks git would run. One whose `.git` names a worktree's git folder
whose repository isn't there, as when its checkout moved, stays and
is refused, since `git worktree repair`, run from that checkout, can
mend it where it is.

**It will not keep a branch trunk already has.** Releasing or
reclaiming a tree deletes its branch, and the `[branch]` section a
push wrote, when every commit on it is on the remote's trunk as last
fetched, since trunk then holds all of it. A branch with any commit
trunk lacks, pushed or not, stays, and so does one another checkout
has out. On 19 November core.nix's checkout held 5,734 local
branches and 518 KB of config from released trees, read by every git
command there, the host's presence publish among them. A branch
whose tree went before it merged goes later, when a sweep finds
trunk holding it, no tree on it and its reflog unmoved for a day.
One another branch is stacked on, or with no reflog, stays. A sweep
takes at most 500 a checkout, the next the rest, and its line names
each that went with its commit, under `branches`, so
`git branch <name> <commit>` puts one back.

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
