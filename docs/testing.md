# Testing

How the checks run and why they are shaped as they are.
[AGENTS.md](../AGENTS.md) keeps the commands and the traps worth
knowing before running anything.

## Typecheck

`tsc --noEmit` runs in `pnpm check` over the whole project: every
extension, every library, every test, the scripts and the
root config files.

```sh
pnpm typecheck
```

This used to cover a handful of directories, because the
older extensions carried type debt that predated tsc being
wired in at all. That debt is gone: the project reports
nothing, so the scope is everything and the narrow config
has been deleted.

Keep it that way. A single failing file is worth fixing on
the spot; the alternative is a second exclusion list, and
that is how the first one started. Note that the scope
includes root files such as `vitest.config.ts`, which sat
outside it and held a real error while the project called
itself clean.

## Sending a Check Elsewhere

On optimus, `elsewhere` runs a check as you go on whichever machine
mycelium places it, without a push:

```sh
elsewhere where harness-check                   # where mycelium would place it, and why
elsewhere run harness-check -- pnpm typecheck   # or: pnpm exec vitest run <paths>
```

It travels only from a session on a quest, through that quest's
handover; with no quest it runs here. Run it from the checkout's top,
since what travels is the folder it runs in: the files git tracks
there, as they lie, so edits not yet committed go too. A new file goes
only once `git add` tracks it. Otherwise it stays behind: code that
needs it fails far as though the code were at fault, code that copes
without it passes having checked less, and a file nothing reaches goes
unchecked, a test file not run and a module not typechecked, so the
far run passes without it unless every file named stayed behind. So
look at `git status` before sending, and add the files you mean to
send by name, not with `git add -A`, which would send scratch files
too. Hidden files never travel, tracked or not: `.git`, `.pi/skills`
and `.npmrc` stay here. The far side installs the packages from the
lockfile with its own work toolchain's pnpm.

So keep to here, with `--here`, anything that reads what stays behind:
`tests/package` asks git for its files and reads `.pi/skills`, and
`--changed` asks git what changed, so `pnpm test`, `pnpm test:unit`,
`pnpm test:changed` and `pnpm check` all run here. Keep to here for
Linux too: on the work Mac, every test that runs only on Linux, such
as the fence's, the shell sandbox's and the host's, skips, so a pass
there says nothing of them. The same goes for a test that skips where
a tool it needs is missing, such as verify's npm runs.

A run that fails far, its setup included, ends with that failure
rather than running again here. Run it again with `--here`: a failure
here too is the code's. One only far is a file left behind, the far
machine, or code that fails only there, as on macOS or in a flaky
test, so read the far failure before deciding which.

An agent's run goes only to a machine that declares a fence for
agents at least as tight as optimus's, and mycelium places it only
among those: with none to take it, it runs on optimus and says why.
The work Mac is the machine it is meant for, once it declares one.

`pnpm check:there` stays the way to send the whole gate, for a pushed
branch. Run under pi it goes only to penelope, the host agreed for
agents' checks; Joel, running it from a shell outside pi, may name
another, such as the work Mac.

## Tests

Library code under `lib/` has unit tests written with vitest.
Specs live under `tests/` mirroring the source layout (e.g.
`tests/lib/ui/badge.test.ts` exercises `lib/ui/badge.ts`).
Run the suite with:

```sh
pnpm test            # everything, about 94s
pnpm test:unit       # only the unit project, about 26s
pnpm test:changed    # the tests this branch's changes reach
pnpm test:host       # a real host end to end, on the host's built pi
pnpm test:watch      # re-run on save
pnpm test:coverage   # v8 coverage report
```

`pnpm test:changed` follows the import graph from every file the
branch changed since `origin/main`, whether committed, staged or only
edited, to the tests that import it, across both projects. It is the
check to run before a merge. A new file counts only once git knows it
(`git add -N` is enough), and a change to `package.json`, the
lockfile, the vitest config or a setup file reaches every test, so it
runs them all.

`pnpm test:host` is the host's one gate. It runs every host check that
needs a real pi: the end-to-end ones (E1 to E8, the sealed host and the
screens), the engine's and the parity tests (`tests/host/engine`,
`tests/host/parity`), on a pi built with the host's patches, which an ordinary check can't build:
elsewhere they skip, saying how to get one, and here they fail
without one, since no CI runs them; any case that skips under it, for
whatever reason, fails the run. A host's rollout runs it first;
`tests/host/end-to-end/README.md` says where the pi is found.

A new pi reaches the hosts only through that gate.
`node scripts/host-prove.ts RUNTIME --proof FILE` runs `pnpm test:host`
on a piHostRuntime build, as it stands, from a clean checkout. Only once
every case has passed does it write the runtime's proof and move the
runtime link to it. Where the run goes to a lent builder, as a
derivation with no git, `--report REPORT --harness COMMIT` judges that
run's JSON report the same way and records the commit its source was cut
at. REPORT may instead be the whole saved log of one
`scripts/host-test-there.sh` run, which `scripts/host-run.sh` makes
print its report; the log must name COMMIT and RUNTIME and say the run
exited 0. A realm names the proof beside its pi. core.nix fails
evaluation when the proof names another runtime, and the host program
refuses to start without a proof of its own pi
(`host/service/proof.ts`). The proof names the harness commit that ran,
as a record only: it proves the pi, not the harness.

A harness change reaches the hosts through a gate of its own, since
`pnpm check` skips the host cases wherever no runtime is installed.
`bash scripts/host-test-there.sh` runs the whole of `pnpm test:host` for
the commit checked out on a lent builder, through `nix-offload there
--run`, on the runtime the hosts are proven on. nix-offload's keeper keeps
the pass, with the words that ran, where no session can write, so the
script writes no record of its own. Inside the agent fence, which hides the
builders' key, it prints that call instead, to be run alone, which the
fence lets out. Given test files, it runs only those, which answers for a
branch's own tests but clears no merge. `scripts/merge-gate.sh` is the harness's
`review.merge.gates` entry. It first runs Biome's check over every file the
head changes, read from that commit, with the Biome the head pins, so a
change written where Biome can't run (the work Mac's security software
stops it while its wrapper exits 0) can't merge unformatted or unlinted;
a fault already on main refuses nothing new. Then it runs
`scripts/host-gate.sh`: a change that touches nothing a host runs
(`host/`, `lib/ui/`, `lib/core/session/`, `lib/core/viewer/`,
`tests/host/`, the host scripts, `package.json`, the lockfile and the
vitest config, and the extensions and libraries whose tools the host
cases drive: jobs, loadout, mesh, park, quest, reload, result store,
spend and subagent) merges as before; one that does merges only once the
keeper kept a whole run passing at that very commit, its words exactly
those `scripts/host-test-words.sh` makes for that runtime and this
machine's tools, since the keeper keeps any program that passed. A refusal names the
command that clears it. A merge outside `review_offer`, on GitHub's page,
skips it, as it skips core.nix's `merge-net ready`.

New library modules should ship with tests that assert
**observable behaviour through the public API**, never
internals. A test that would still pass after a legitimate
refactor is a good test. A test that breaks when you rename a
private helper is testing internals.

Extension wiring (`renderCall`, `renderResult`, tool
registration, pi-side gates) is generally not unit-tested
because it depends on pi's runtime context. Exercise that
live via `/reload` in a running pi session, or with
`pi -e ./extensions/some-ext` to load a single extension in
isolation.

**A session runs the extension it loaded at startup.** Editing
a file here does not change the tools in the session you are
editing from, even though this package is installed by path.
So driving a tool is evidence about whatever was loaded, not
about the working tree, and the gap is invisible: the tool
answers normally and answers the old way. This has already
produced a confident bug report against behaviour that had
been fixed hours earlier. Before treating a live tool run as
evidence, call the `reload` tool onto the tree you changed, or
check the claim against the test suite, which always runs the
tree. After `reload`, `/harness` says which code the session
runs, and the footer shows `⇄` while it is a tree.

**A reload re-evaluates a `.ts`, but not a `.mjs`.**
Measured, not inferred: build a jiti the way pi builds one,
with `moduleCache: false`, and import a barrel over a leaf.
Edit a `.ts` leaf and the new value arrives on the next
import. Edit a `.mjs` leaf and the old value comes back, and
an export added to it reads `undefined`. Taken against pi
0.84.1 and the jiti it ships; the routing that produces this
is jiti's business and was not read, so treat the behaviour
as the fact and not the explanation.

That is what killed a council. A constant had been added to
`runpi/journal.mjs` and merged mid-session, the reloaded
`tools/ask.ts` read it, the value was the one from before
the merge, and seven reviewers died on `Cannot read
properties of undefined (reading 'split')` before any of
them spawned. The round left no reviewer directories at all,
which is how a crash in the parent is told from one in a
child.

Three files can do this, and they are the `.mjs` a running
pi imports a value out of: `runpi/journal.mjs`,
`runpi/assistant.mjs` and `runpi/grace.mjs`. Any change to
one under a live session sets it up, whether it arrived by
merge, by rebase or by your own editor. `runpi/watchdog.mjs`
and `runpi/supervisor.mjs` are not on the list, and the
reason is the opposite one: nothing in this process imports
them, because they run in a child that is spawned fresh and
reads them off disk every time. The hazard there is the
mirror image, a parent that reloaded and a child that did
not, disagreeing about a constant they share.

Reads of those three are guarded, so the next occurrence
names itself instead of throwing arithmetic on `undefined`
somewhere downstream: see `runpi/fresh.ts`. The guard cannot
stop the staleness, only the mystery.

The obvious fix is to stop having `.mjs` at all, since node
has stripped types since 22.18 and this package demands
22.19. It was tried, and it cannot be done. Node refuses to
strip types anywhere under a `node_modules` directory, which
is where a consumer install puts this package, and refuses
with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` at the
first import. The spawned supervisor would not start at all,
and no test here would say so, because a package installed
by path is outside `node_modules` and strips fine. A council
ran green through the converted script on this machine while
being broken for everybody who installs the package
normally.

So the seam is structural. A module shared between a parent
pi loads through jiti and a child node spawns directly has
to be a `.mjs`, and a `.mjs` is the thing a reload cannot
refresh. Removing the hazard needs a build step, and this
package does not have one on purpose.

**After pi upgrades, restart rather than reload.** A session
pins its subagents to the install it started from, on
purpose: `lib/subagent/install.ts` stashes that snapshot
under a `Symbol.for` key so a reload cannot recapture a
path an upgrade has since deleted. The consequence is that
when the versioned `~/.pi/pkg/pi-<version>` directory does
go, every child dies at startup on a path the parent is
still pointing at, and a reload cannot help, because the
running process is the old one either way. A whole council
was lost to this, a different one from the council above.
The snapshot needs a global key precisely because a reload
does re-evaluate this module, the same re-evaluation the
previous note is about.

`pnpm test` runs everything in about 94 seconds but the browser
tests, which drive a real Chrome in a lane of their own,
`pnpm test:browser`. That lane fails before any test runs where
there is no Chrome, rather than skipping every suite and reporting
a pass that tested nothing.

It was not always this fast, and the reason is worth knowing because
it was not a slow test anywhere. The browser lane ran twice, once in
its own job and once inside `pnpm test`, and it ran one file at a
time because four workers had been observed putting seven browsers on
the machine. Seven was the tell: four workers cannot make seven
browsers unless something else is running them too. The duplication
caused the contention, the contention justified the serial lane, and
the serial lane made the duplication expensive. Removing the
duplication let the lane run four wide, which took it from 275s to
70s and the whole suite from roughly five minutes to 94s, with the
race guard enabled and no race.

The pool cap counts workers, not processes, which matters when a test
spawns one: a supervisor test is node spawning a script spawning a
child. That is how the suite used to drive the load average to 24 on
a twelve-core machine and then starve its own subprocess tests until
they blew a two-minute budget. If you add a test that spawns
something, keep its budget small enough that a starved run says so in
seconds.

Those tests now have their own lane, `process`, listed by name in
`vitest.config.ts` and run one file at a time on one worker. Capping
the pool was not enough on its own: a supervisor test competing with
four workers of ordinary tests starves the very child it is watching,
and the failure reads as a reviewer that would not spawn rather than
as a machine that was busy. Two cases failed that way for weeks and
were green whenever anybody ran them alone, which is the signature.
Add a test that spawns node from node to that list; the six there
now are the subagent supervisor's, the reviewer's, the fleet's and
the load check's, not every test that shells out. It costs about 45 seconds, and `pnpm test` runs every
project, this one included.

There is no CI. `pnpm check` runs `pnpm lint`, `pnpm typecheck`,
`pnpm knip` (an unused file, dependency or export fails it), the tests the change touches beside
origin's main, the browser
tests it touches (`pnpm test:browser:changed`), and
`pnpm load-check`, before merging. A change that reaches no
browser test runs none, so only one that does needs a Chrome. The load check installs a copy with production dependencies only, the way pi
installs from git, and loads it through pi with nothing else
loaded; it is the only check that sees a runtime dependency the
install does not hold.

Lint runs Biome through `scripts/lint.ts`, which fails when Biome
was killed or exited 0 without saying it checked any file. Biome's
own node wrapper reads a killed binary as success, and on a Mac in
Santa's lockdown the binary is killed at its start, so `pnpm lint`
once passed there having checked nothing. Lint runs on optimus.
