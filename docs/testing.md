# Testing

How the checks run and why they are shaped as they are.
[AGENTS.md](../AGENTS.md) keeps the commands and the traps worth
knowing before running anything.

## Typecheck

`tsc --noEmit` runs in CI over the whole project: every
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

## Tests

Library code under `lib/` has unit tests written with vitest.
Specs live under `tests/` mirroring the source layout (e.g.
`tests/lib/ui/badge.test.ts` exercises `lib/ui/badge.ts`).
Run the suite with:

```sh
pnpm test            # everything, about 94s
pnpm test:unit       # only the unit project, about 26s
pnpm test:browser    # only the browser tests
pnpm test:watch      # re-run on save
pnpm test:coverage   # v8 coverage report
```

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

`pnpm test` runs everything, browser tests included, in about 94
seconds. Set `CHROME_PATH` or the browser tests skip themselves.

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
Add a test that spawns node from node to that list; the five there
now are the supervisor and reviewer suites, not every test that
shells out. It costs about 45 seconds, and `pnpm test` runs every
project, this one included.

CI runs `pnpm lint`, `pnpm typecheck`, `pnpm test` and
`pnpm load-check` on every pull request and every push to `main` via
`.github/workflows/ci.yml`, as four parallel jobs. The load check
installs a copy with production dependencies only, the way pi
installs from git, and loads it through pi with nothing else
loaded; it is the only check that sees a runtime dependency the
install does not hold.
