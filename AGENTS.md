## What This Is

A pi package: a collection of extensions and skills that other
people install into their pi setup. There is no build step; pi
compiles TypeScript at runtime. Library code is unit-tested
with vitest under `tests/`. Third-party dependencies live in
the root `package.json`.

The package manager is **pnpm**. `pnpm-lock.yaml` is canonical;
`package-lock.json` is gitignored to prevent drift.

This file is the index: each rule in a line, with the reasoning
in [`docs/`](./docs/). Read the linked page before changing what
a rule covers.

## Structure

- `lib/`: shared library code in three layers: public modules
  exported in `package.json`, shared modules the extensions here
  use but don't export, and `lib/internal/`, which nothing
  outside the package imports. [`lib/README.md`](./lib/README.md)
  lists every module and what it is for
- `extensions/`: Pi extension wiring, organized by
  behavioural contract (see Extension Categories)
- `packs/`: extensions loaded into a subagent by path, never
  auto-discovered, so deliberately not under `extensions/`
- `skills/`: package-bound markdown instructions the agent
  loads on demand when a task matches their description
- `docs/`: the reasoning behind the rules here, a page a
  subject
- `scripts/`: programs run by hand or by `pnpm`: the load
  check, the sensors, and one-shot migrators of the quest store
- `tests/`: the tests, mirroring the source;
  [`tests/README.md`](./tests/README.md) says which folders
  don't
- `.pi/skills/`: project-local skills for developing this
  package (not shipped to consumers)

Every folder says what goes in it: a README.md, an entry file
whose first line is a comment, or a bullet in its parent's
README opening with its name and a colon, as
`tests/package/every-folder-says-what-it-holds.test.ts` holds.
A new folder gets its note in the change that makes it.

Public library modules have barrel exports (`index.ts`) that
define what external consumers can import. Internal modules
are consumed by extensions via direct file imports.

## Extension Categories

Every extension's directory name ends in the contract it keeps.
[`docs/extensions.md`](./docs/extensions.md) says what each
category commits to and why each workflow and integration exists.

- **Guardians** (`*-guardian`): intercept a shell command and
  show it for review, inline or in a gate as the guard policy
  says. They implement `CommandGuardian<T>`.
- **Interceptors** (`*-interceptor`): rewrite or block a shell
  command silently, with no review.
- **Workflows** (`*-workflow`): a multi-step or session-wide
  process with state and stages.
- **Integrations** (`*-integration`): bridge to an outside
  service through registered tools.
- **Widgets** (`*-widget`): add something to pi's interface.
- **Providers** (`*-provider`): give a host an implementation
  over the `pi.events` bus, without importing the host.
- **Packs** (`packs/`): an extension a subagent loads by path,
  never auto-discovered, so never under `extensions/`.

## Skill Categories

Skill names follow `{domain}-{concern}-{suffix}`, the suffix
saying what kind of guidance it is: `-guide` (how to do
something), `-convention` (rules for using a tool), `-format`
(the shape of an artifact) or `-standard` (quality and style).
The `taxonomy-guide` skill in `.pi/skills/` has the naming rules,
the domains, and when to write a skill, an extension or a line
here. Skills teach a method; extensions enforce it.

## Conventions

- Each extension and skill directory has a README.md for
  humans.
- Extensions use JSDoc headers describing their purpose.
- Skills have a SKILL.md (loaded by pi) and a README.md
  (for browsing). Do not duplicate content between them.
- **Never put a README.md in the `skills/` root.** Pi treats
  any `.md` file there as a skill.
- Import pi as `@earendil-works/pi-coding-agent`,
  `@earendil-works/pi-ai` and `@earendil-works/pi-tui`. Pi
  provides them, so they are optional peers and dev
  dependencies, never `dependencies`;
  [`docs/dependencies.md`](./docs/dependencies.md) says why
  each declaration sits where it does.
- Every mechanical rule a skill states is tracked in
  [`docs/convention-coverage.md`](./docs/convention-coverage.md)
  against the gate that enforces it. When adding a rule to a
  skill or a gate to the code, update the matrix in the same
  change so the coverage stays visible.

## Design Rules

The code should read like a description of what the system does,
not how it wires things up. Each rule's reasoning, and the cost
that taught it, is in [`docs/architecture.md`](./docs/architecture.md).

- Split a file by its reasons to change, not by its length.
- Share behaviour through types and helper functions, never class
  hierarchies.
- A guardian runs detect, parse, review, and is wired by
  `registerGuardian`; it never touches event wiring or mutates
  the command itself.
- Every guard declares its class and mode from the one catalogue,
  `lib/internal/guardian/guards.ts`. A refusal goes through
  `refusalUnder` and a confirmation through `asksUnder`
  (`lib/guardian/apply.ts`); never branch on a mode by hand.
- A workflow keeps its concerns in `state.ts`, `lifecycle.ts`,
  `enforce.ts`, `transitions.ts` and `index.ts`, merging
  neighbours that would be trivially small.
- The prompt is append-only: never edit what a request has sent,
  in the system prompt or earlier messages. Say a change as a new
  message, supersede stale context rather than removing it, and
  use `registerStandingContext` (`lib/prompt`) for state the
  model should always know.
- Don't merge two modules that merely look alike today.
- A tool whose answer can outgrow a context window stores it and
  cites a handle (core's `result` module), or answers with a
  path on disk; never inline everything or truncate.
  `tests/package/stored-results.test.ts` checks each tool.
- A helper several domains use lives in the shared library at the
  level of its concern, not in the first domain that needed it.
- Every export in a public barrel is a long-term commitment;
  implementation details stay out of it.
- An integration's API client, auth, renderers and types live in
  `lib/`; the extension keeps only pi's wiring and owns caching.
  Analysis of what a service returned never needs the service.
- An extension's `index.ts` registers and wires, and reads as a
  table of contents; event handlers delegate to named functions.
  A tool's `execute`, `renderCall` and `renderResult` stay in
  its registration, delegating substantial work.
- Only the guardian registration helper and interceptors mutate
  `event.input.command`.
- Prefer type guards to `as` casts (pi's `renderCall` and
  `renderResult` excepted), top-level `import` to `require()`,
  and named constants to magic numbers. Every empty `catch {}`
  says why the error is safe to ignore, and every exported
  function has a JSDoc comment saying what it does.

## Commands

```sh
pnpm check           # lint, typecheck, the tests a change touches, load check
pnpm lint:fix        # auto-fix, then verify
pnpm lint            # no errors and no warnings, before committing
pnpm typecheck       # tsc over the whole project, which reports nothing
pnpm test            # everything, about 94 s
pnpm test:unit       # the unit project, about 26 s
pnpm exec vitest run <paths>   # the tests a change touches, as you go
```

Always run `lint:fix` first: Biome's fixes are safe here. Fix the
code to satisfy the linter rather than suppressing a rule, and fix
a failing type on the spot rather than excluding its file. There
is no CI: `pnpm check` runs before merging, on this machine, and
runs only the tests the change touches beside origin's main; run
`pnpm test` as well for a change that crosses many modules. The
load check installs production dependencies only, as pi does from
git.

New library code ships with tests of observable behaviour through
its public API, under `tests/` mirroring `lib/`. Extensions are
tested the same way, under `tests/extensions/`.
[`docs/testing.md`](./docs/testing.md) has the lanes, timings and
history.

## Before Trusting a Live Run

- **A session runs the extension it loaded at startup.** Editing a
  file here changes nothing in the session editing it. Call the
  `reload` tool onto the tree you changed before treating a live
  tool run as evidence; `/harness` says which code runs.
- **A reload re-evaluates a `.ts`, not a `.mjs`.**
  `runpi/journal.mjs`, `runpi/assistant.mjs` and
  `runpi/grace.mjs` keep their old values in a reloaded session,
  so a change to one under a live session needs a restart. They
  can't become `.ts`: node won't strip types under
  `node_modules`, where consumers install this package.
- **After pi upgrades, restart rather than reload.** Subagents are
  pinned to the install the session started from.
- **A test that spawns node from node goes in the `process`
  lane** listed in `vitest.config.ts`, which runs one file at a
  time; keep its budget small enough that a starved run says so
  in seconds.

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
  contracts differ (quest-workflow intercepts writes,
  job-workflow hosts work that outlives its tool). File naming
  convention is the right level of shared structure.
- Do not mutate `event.input.command` outside of the
  guardian registration helper or interceptor extensions.
  Those are the two sanctioned mutation sites.
- Do not leave empty `catch {}` blocks without a comment
  explaining why the error is safe to ignore.
