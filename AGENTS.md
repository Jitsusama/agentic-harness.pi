## What This Is

A pi package: a collection of extensions and skills that other
people install into their pi setup. There is no build step; pi
compiles TypeScript at runtime. Library code is unit-tested
with vitest under `tests/`. Third-party dependencies live in
the root `package.json`.

The package manager is **pnpm**. `pnpm-lock.yaml` is canonical;
`package-lock.json` is gitignored to prevent drift.

## Structure

- `lib/`: shared library code, split into public and internal
  - `lib/ui/`: TUI primitives: panels, prompts, content
    rendering, navigable lists, text layout (public)
  - `lib/slack/`: Slack API client, authentication,
    renderers, resolvers and types (public)
  - `lib/google/`: Google Workspace API clients,
    authentication, renderers and types (public)
  - `lib/work/`: the working layer under a review: where a tree
    is cut from, what pins it, which provider serves a repo, and
    the broker holding the trees a session is using (public).
    Tree providers register over the event bus, so one can live
    in another package entirely. The review the working layer
    sits under, `lib/review`, moved to `agentic-harness.core`;
    this package depends on it for `Exec` and the review types
  - `lib/exec/`: running a command, taken as a dependency rather
    than imported (public). One type, one result shape and one
    runner that throws with the backend's own words. Its own
    module because `lib/work` needs it and does not own it;
    `agentic-harness.core`'s `review` re-exports its own copy of
    this, since downstream packages import `Exec` from that
    barrel
  - `lib/process/`: asking the machine about a process, and saying
    which one you meant (public). Its own module on the `lib/exec`
    reasoning: `lib/subagent` asks whether the supervisor holding a
    reviewer's lease is still there and `lib/work` asks whether the
    session holding a worktree is, which is one question, and the
    second was about to be answered by a second copy of the first.
    A pid identifies nothing on its own, so the start time travels
    with it everywhere here; `lib/subagent/lease.ts` re-exports what
    it used to define, since the whole of that module imports these
    from there
  - `lib/remote/`: naming a git remote to a person (public). Its
    own module for the same reason `lib/exec` is: `lib/work` shows
    a remote in its refusals and does not own what a remote may
    safely say. A remote can carry a token as its user or as its
    password, so a message naming one verbatim prints a live
    secret; the credential comes out for display and stays in for
    the fetch
  - `lib/clock/`: what a duration bounding a child process may
    be (public). Its own module on the `lib/exec` reasoning: the
    rules belong to the runner, which is the last place they can
    be applied, and the first place they are needed is whoever
    reads a duration out of a config file. One definition, two
    readers, so a roster cannot accept a clock the runner will
    then throw over from inside a paid round
  - `lib/guardian/`: guardian contract, registration and
    redirect formatting (public)
  - `lib/shell/`: shell command parsing: flag extraction,
    heredoc stripping, splitting, quoting (public)
  - `lib/command/`: lossless, range-indexed command model:
    tokenize, the caller-spec flag layer, splice-by-range
    editing and the effective working directory (public)
  - `lib/internal/`: not for external use
    - `git/`: process-global bypass state for git
      command interception
    - `guardian/`: commit-specific parsing and entity review
    - `github/`: GitHub utilities (CLI parsing, diff,
      GraphQL, PR identity, review posting)
    - `state.ts`: session state helpers
- `extensions/`: Pi extension wiring, organized by
  behavioural contract (see Extension Categories below)
- `packs/`: extensions loaded into a subagent by path, never
  auto-discovered, so deliberately not under `extensions/`
- `skills/`: package-bound markdown instructions the agent
  loads on demand when a task matches their description
- `.pi/skills/`: project-local skills for developing this
  package (not shipped to consumers)

Public library modules have barrel exports (`index.ts`) that
define what external consumers can import. Internal modules
are consumed by extensions via direct file imports.

## Extension Categories

Every extension has a contract suffix that identifies what
it does:

- **Guardians** (`*-guardian`): intercept shell commands and
  present a human review gate. Implement `CommandGuardian<T>`
  with detect → parse → review.
  `commit-guardian`, `pr-guardian`, `issue-guardian`,
  `history-guardian`

- **Interceptors** (`*-interceptor`): intercept shell commands
  and modify or block them silently, without a review gate.
  `attribution-interceptor`, `git-cli-interceptor`,
  `github-cli-interceptor`

- **Workflows** (`*-workflow`): orchestrate a multi-step or
  session-wide process with state and stages. This covers
  persistent session workflows such as planning and TDD.
  `quest-workflow`, `tdd-workflow`,
  `ask-workflow`, `git-bypass-workflow`,
  `guardian-status-workflow`, `result-store-workflow`

- **Integrations** (`*-integration`): bridge to external
  services via registered tools.
  `google-workspace-integration`, `web-search-integration`,
  `browser-integration`, `review-integration`,
  `work-integration`

  The last two are worth a note, because they bridge to
  whatever hosts a change rather than to one named service.
  `review-integration` hosts the six review tools over
  `agentic-harness.core`'s `review`, and every provider behind
  them registers over the event bus, so the extension has no
  idea which backends exist. `work-integration` does the same
  for `lib/work` and
  the trees underneath. Neither imports the other: the review
  side reaches the working layer over the bus, so a consumer
  needs the work *library* and never the work *extension*.

- **Widgets** (`*-widget`): add UI elements to the interface.
  `content-viewer-widget`, `status-line-widget`,
  `panel-zoom-widget`

- **Providers** (`*-provider`): contribute a `FrontEndProvider`
  to an MCP host over the `pi.events` bus, decorating a subset
  of a server's tools (shape, render or wrap) without importing
  the host's registry. Distinct from a `*-widget`, which adds
  standalone UI, and from an `*-integration`, which hosts a
  service. The seam is the bus, so a provider can live in a
  different package from its host.

- **Packs** (`packs/`): an extension loaded into a subagent
  with `pi --extension <path>` and never auto-discovered, so
  one must not live under `extensions/`: a directory pi scans
  is the wrong place for a thing pi must not load. A pack's
  tool belongs to the subagent, not to the session that
  dispatched one.

  `packs/review-journal` ships one, so a reviewer can write a
  finding down the moment it has one rather than saving every
  finding for an answer an interruption then takes. It is
  offered only for the finding-shaped rounds.

  A verifier is the other kind, a tool a subagent calls to
  validate its structured output against a schema before
  finishing. None ship; the `subagent` tool's `verify` option
  is how a caller attaches one.

  Note what the review rounds deliberately do not do. They
  attach a contract skill without a verify tool, so a
  malformed entry is dropped and warned about rather than
  refused, and a reviewer that half-follows the contract
  still contributes what it got right. The journal keeps that
  bargain: it writes down whatever shape it is handed and
  lets the round judge it, because a tool arguing with a
  reviewer about a missing field spends the budget the
  reviewer needed for the review.

## Skill Categories

Every skill has a type suffix that identifies what kind of
guidance it provides:

- **Guides** (`*-guide`): teach how to do something.
  Step-by-step instructions, principles, decision criteria.
- **Conventions** (`*-convention`): operational rules for
  using a tool.
- **Formats** (`*-format`): structural templates for
  artifacts.
- **Standards** (`*-standard`): opinionated quality and style
  preferences.

Skill names follow `{domain}-{concern}-{suffix}`. See the
`taxonomy-guide` skill in `.pi/skills/` for the full naming
rules, domain definitions and decision framework.

Extensions and skills are complementary. Skills teach
methodology; extensions enforce it. Some are paired (e.g.,
the `planning-guide` skill + `quest-workflow` extension) but
they all work independently.

## Conventions

- Each extension and skill directory has a README.md for
  humans.
- Extensions use JSDoc headers describing their purpose.
- Skills have a SKILL.md (loaded by pi) and a README.md
  (for browsing). Do not duplicate content between them.
- **Never put a README.md in the `skills/` root.** Pi treats
  any `.md` file there as a skill.
- Imports from pi use `@earendil-works/pi-coding-agent`,
  `@earendil-works/pi-ai` and `@earendil-works/pi-tui`.
  These are provided by pi at runtime; do not add them to
  `dependencies`. They appear in three other places, each
  for its own reason, and all three are enforced by
  `tests/package/runtime-deps.test.ts`:
  - `peerDependencies` at `"*"`, under the current
    `@earendil-works/*` names, because that is the
    relationship: pi hands these to an extension at load
    time, and which version is the host's business.
  - `peerDependenciesMeta` marking every one optional,
    because npm installs a root package's peers otherwise
    and pi runs `npm install --omit=dev` on a git install.
    Measured: without the flag, one declaration pulled 189
    packages into a clean tree, among them a deprecated
    copy of pi's whole runtime three minor versions
    behind. A second copy of pi's modules is a different
    copy, and the instanceof checks in its own APIs stop
    holding.
  - `devDependencies`, so `tsc` has the real declarations
    on disk. Naming the same packages here as in
    `peerDependencies` is also what stops pnpm installing
    its own: pnpm installs peers by default and ignores
    the optional flag, but it finds these already
    satisfied. Consumers never receive them, since
    `--omit=dev` skips the list entirely.

  Pi's loader also aliases the older `@mariozechner/*`
  spelling, which this repo imported until every site was
  migrated. Do not reintroduce it: those packages are
  published deprecated, pi's loader comment says the compat
  aliases stay only until compat is removed, and the
  `tsconfig.json` and vitest mappings that used to bridge
  the two names are gone.
- Every mechanical rule a skill states is tracked in
  [`docs/convention-coverage.md`](./docs/convention-coverage.md)
  against the gate that enforces it. When adding a rule to a
  skill or a gate to the code, update the matrix in the same
  change so the coverage stays visible.

## Design Principles

The code should read like a description of what the system
does, not how it wires things up. Every module should use
idiomatic TypeScript, handle errors honestly and serve as an
example of clean Pi extension code.

### Split by Responsibility, Not Line Count

A 300-line file that does one cohesive job is fine. A 150-line
file with three interleaved responsibilities should be split.
The question to ask is whether the file has multiple reasons
to change, not whether it's long.

### Composition Over Inheritance

Shared behaviour uses types and helper functions, not class
hierarchies. Each guardian is a plain module that implements
the shared interface; a registration helper wires it into
Pi's event system. Workflows share a file naming convention
but no base type because their runtime contracts differ.

### Guardian Pipeline: detect → parse → review

Every guardian follows the same three-step pipeline:

1. **detect**: does this command match? (fast, no parsing)
2. **parse**: extract structured data from the command
3. **review**: present the data for human review, return a
   result (undefined to allow, block, or rewrite)

A new guardian implements the shared interface and calls the
registration helper; it never touches event wiring or command
mutation directly. See `lib/guardian/` for the public contract
(downstream packages import from `./guardian`).

### Workflow File Convention

Each workflow extension uses these files:

- `state.ts`: state interface and initial/default values
- `lifecycle.ts`: activate, deactivate, toggle, persist,
  restore
- `enforce.ts`: tool_call interception: what gets blocked,
  what gets allowed and why
- `transitions.ts`: confirmation gates, context injection,
  stale context filtering
- `index.ts`: registration only: declares state, registers
  commands/shortcuts/flags, wires other modules to pi events.
  Should read as a table of contents for the extension.

Not every workflow needs every file; merge neighbours if a
file would be trivially small. But the naming convention is
what tells readers where to find each concern.

### Don't Merge Things That Merely Converge

Two modules that happen to look similar today aren't
necessarily the same abstraction. PR and issue guardians
share a shape via `CommandGuardian` but aren't merged into a
factory; they're independently motivated and could grow
separate concerns. When deciding whether to deduplicate, ask
yourself: are these the same concept, or just coincidentally
similar right now?

### A Large Answer Is Stored, Not Truncated

A tool that can produce a payload larger than a context window
keeps the whole payload and hands back a bounded view plus a
handle. It never inlines everything, and it never truncates into
oblivion: the caller who needed the part that was cut has to be
able to reach it without calling the tool again and guessing at
different arguments.

Use agentic-harness.core's `result` module: `citeListing` for a rendered listing whose
records are to hand, `boundedByDetails` where a family already
passes its records through a result's details, and `cite` for
anything shaped differently. A handle is cited exactly when the
stored payload holds more than the view shows, and that decision
belongs to `cite` rather than to each family.

Answering with a path on disk is the same bargain by another road
and is equally acceptable: `web_read` returns a bundle manifest
and `subagent` names each fan-out result file.

`tests/package/stored-results.test.ts` checks that every
tool-registering extension has been accounted for one way or the
other, so a new tool cannot quietly skip the question.

### Keep Concerns in Their Domain

Each module should own its concern and nothing else. When a
helper is used by multiple domains, it belongs in the shared
library at the level that matches its concern, not in the
first domain that needed it.

### Public Library vs Internal Code

The `lib/` directory is split into public modules (with
barrel exports) and `lib/internal/` (no barrels).

**Public modules** (`lib/ui/`, `lib/slack/`, `lib/google/`)
have an `index.ts` barrel that declares the public surface.
Every export in a barrel is a long-term commitment: other
Pi packages depend on it. Only export interfaces consumers
need to get value from the library. Implementation details
(cache management, parameter parsing, layout plumbing) stay
out of the barrel even if they're exported from the file
itself.

**Internal modules** (`lib/internal/`) have no barrels.
Extensions import directly from specific files. These are
free to change without worrying about external consumers.

External consumers import from barrels, never from internal
files. Internal extensions may import from either barrels or
specific files depending on what they need.

### Integration Architecture

Integration extensions (`*-integration`) bridge to external
services. Their domain logic, meaning API clients,
authentication, renderers and types, lives in `lib/` as a
public library.
The extension keeps only Pi-specific wiring: tool
registration, `renderCall`/`renderResult`, slash commands,
confirmation gates and session lifecycle.

This split means other Pi packages can use the library
(e.g., call the Slack API) without loading the extension.
The extension is a thin consumer of its own library.

**Caching belongs in the extension**, not the library.
Authentication functions like `ensureAuthenticated` are
stateless: they read credentials, build a client and
return it. The extension wraps this in a cache (`Map` or
local variable) so repeated tool calls within a session
reuse the same client. The library stays pure; the
extension owns session lifetime.

**Analysis must not require the service.** Where an
integration's library also analyses what the service returned,
that analysis takes serializable data and returns answers, with
no path back to the client that fetched it. `agentic-harness.core`'s
`web` (the browser engine this package's `browser-integration` and
`web-search-integration` extensions drive) holds the strongest form
of this: every subdomain but `session` can judge a stored capture,
or one taken by a different tool entirely, and none of them can
start a browser. It is worth stating because it breaks silently. A
disk sink that imported the page reader once dragged `jsdom` into
anything writing a PNG, and neither the types nor the tests
noticed. Its `tests/web/purity.test.ts`, in that package, walks the
import graph and fails when an analysis barrel reaches something
heavy.

### `index.ts` Is for Registration and Wiring

Extension `index.ts` files declare state, register commands,
event handlers and tools, then wire to other modules. They
should read as a table of contents.

**Event handlers** should delegate to named functions in other
files. This prevents interleaving where five concerns get
shuffled by event registration order.

**Tool registration** is an exception. Pi's `registerTool`
API bundles `execute`, `renderCall` and `renderResult` as
part of the registration call. Extracting those to separate
files would split one cohesive tool definition across
modules. That said, the execute body should still delegate to
other modules for substantial work (showing gates, lifecycle
changes) rather than inlining all logic.

### One Mutation Site for Command Rewriting

The guardian registration helper is the single place that
mutates `event.input.command` for guardians. Individual
guardians return a result (undefined, block, or rewrite);
they never touch the event directly.

Interceptors are the second sanctioned mutation site.
They mutate `event.input.command` silently (no review
gate) because that's their contract: transparent command
enrichment.

### Idiomatic TypeScript

- Prefer type guards over `as` casts. Each `as` cast should
  be justified or replaced with a narrowing check. The
  exception is Pi's `renderCall` and `renderResult` APIs,
  which type `args` and `details` as `unknown`; casts there
  are acceptable since you're reading back what you just
  wrote.
- Use top-level `import` over inline `require()`. Use dynamic
  `import()` only when lazy loading is intentional.
- Every empty `catch {}` block must have a comment explaining
  why the error is safe to ignore. Silent swallowing without
  explanation is not acceptable.
- Every exported function needs a JSDoc comment describing
  what it does (not how). Internal helpers need docs only
  when their purpose isn't obvious.
- Replace magic numbers with named constants.

## Linting

This project uses [Biome](https://biomejs.dev/) for linting and
formatting. **Run the linter after making code changes and before
committing:**

```sh
pnpm lint:fix    # auto-fix, then verify
pnpm lint        # confirm no remaining issues
```

Always run `lint:fix` first. Biome's auto-fixes are safe for
this project (import ordering, formatting), so there's no
reason to check before fixing. All code in `extensions/`,
`lib/` and `tests/` must pass `pnpm lint` cleanly (no errors,
no warnings) before being committed. Fix the code to satisfy
the linter rather than suppressing rules.

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

## Testing

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
evidence, `/reload`, or check the claim against the test
suite, which always runs the tree.

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

CI runs `pnpm lint`, `pnpm typecheck` and `pnpm test` on every push
and pull request via `.github/workflows/ci.yml`, as three parallel
jobs.

## What Not to Do

- Do not add build tooling, bundlers or transpilation steps.
- Do not add pi's own packages to `dependencies`. They
  are provided at runtime
  (`@earendil-works/pi-coding-agent`,
  `@earendil-works/pi-ai`, `@earendil-works/pi-tui`), and
  they live in `peerDependencies` at `"*"`, marked
  optional, plus `devDependencies` for typecheck.
  Do not drop the optional flag on a pi peer: npm then
  installs a stale second copy of pi's runtime into every
  consumer's tree. Do not import the deprecated
  `@mariozechner/*` spelling.
  Third-party dependencies belong in the root
  `package.json`'s `dependencies`, not in extension-local
  package.json files. Library code lives in `lib/` and
  resolves dependencies from the root `node_modules`.
- Do not create `.md` files directly in the `skills/` root
  (other than inside subdirectories).
- Do not introduce class hierarchies for guardians or
  workflows. Use interfaces and composition.
- Do not merge PR and issue guardians into a shared factory.
  They are independently motivated.
- Do not add a shared base type for workflows. Their runtime
  contracts differ (plan-workflow intercepts writes,
  tdd-workflow has a phase state machine). File naming
  convention is the right level of shared structure.
- Do not mutate `event.input.command` outside of the
  guardian registration helper or interceptor extensions.
  Those are the two sanctioned mutation sites.
- Do not leave empty `catch {}` blocks without a comment
  explaining why the error is safe to ignore.
