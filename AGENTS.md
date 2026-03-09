## What This Is

A pi package — a collection of extensions and skills that other
people install into their pi setup. There is no build step, no
test suite, and no dependencies to install. Pi compiles TypeScript
at runtime.

## Structure

- `extensions/` — TypeScript modules that enforce guardrails
  (commit review, mode enforcement, UI components)
- `extensions/lib/` — shared library, organized by domain:
  - `lib/ui/` — TUI primitives (panels, gates, content
    rendering, text utilities)
  - `lib/guardian/` — guardian pipeline (types, registration,
    review loop)
  - `lib/parse/` — shell command parsing and gh CLI modeling
  - `lib/state.ts` — session state helpers
- `skills/` — markdown instructions the agent loads on demand
  when a task matches their description

The codebase has four **guardians** (commit, PR, issue, history),
two **modes** (plan, TDD), three **tools** (ask, web-search,
pr-review), a content viewer, and a status line.

Extensions and skills are complementary. Skills teach methodology,
extensions enforce it. Some are paired (e.g. planning skill +
plan-mode extension) but all work independently.

## Conventions

- Each extension and skill directory has a README.md for humans.
- Extensions use JSDoc headers describing their purpose.
- Skills have a SKILL.md (loaded by pi) and a README.md (for
  browsing). Do not duplicate content between them.
- **Never put a README.md in the `skills/` root.** Pi treats any
  `.md` file there as a skill.
- Imports from pi use `@mariozechner/pi-coding-agent`,
  `@mariozechner/pi-ai`, and `@mariozechner/pi-tui`. These are
  provided by pi at runtime — do not add them to package.json.

## Design Principles

The code should read like a description of what the system does,
not how it wires things up. Every module should use idiomatic
TypeScript, handle errors honestly, and serve as an example of
clean Pi extension code.

### Split by responsibility, not line count

A 300-line file that does one cohesive job is fine. A 150-line
file with three interleaved responsibilities should be split.
The criterion is whether the file has multiple reasons to change,
not whether it's long.

### Composition over inheritance

Shared behavior uses types and helper functions, not class
hierarchies. Guardians share a `CommandGuardian<T>` interface
and a `registerGuardian` helper — each guardian is a plain
module that implements the interface. Modes share a file naming
convention but no base type, because their runtime contracts
differ.

### Guardian pipeline: detect → parse → review

Every guardian follows the same three-step pipeline:

1. **detect** — does this command match? (fast, no parsing)
2. **parse** — extract structured data from the command
3. **review** — present the data for human review, return a
   `ReviewResult` (undefined to allow, block, or rewrite)

`registerGuardian` wires this pipeline to Pi's `tool_call`
event. A new guardian implements `CommandGuardian<T>` and calls
`registerGuardian` — it never touches event wiring or command
mutation directly.

### Mode file convention

Each mode extension uses these files:

- `state.ts` — state interface and initial/default values
- `lifecycle.ts` — activate, deactivate, toggle, persist,
  restore (pure functions taking state + pi/ctx)
- `enforce.ts` — tool_call interception: what gets blocked,
  what gets allowed, and why
- `transitions.ts` — confirmation gates, context injection,
  stale context filtering
- `index.ts` — registration only: declares state, registers
  commands/shortcuts/flags, wires other modules to pi events.
  Should read as a table of contents for the extension.

Not every mode needs every file — merge neighbors if a file
would be trivially small. But the naming convention tells
readers where to find each concern.

### Don't merge things that merely converge

Two modules that happen to look similar today aren't necessarily
the same abstraction. PR and issue guardians share a shape via
`CommandGuardian` but are not merged into a factory — they are
independently motivated and could grow separate concerns. When
deciding whether to deduplicate, ask: are these the same
concept, or just coincidentally similar right now?

### Keep concerns in their domain

- `formatSteer` lives in `gate.ts`, not `lib/guardian/`,
  because both guardians and modes use it — it's gate output
  formatting, not guardian domain logic.
- Field editing logic (`edit`, `steerText`) lives on the field
  types, not in the review loop. The review loop calls
  `field.edit()` without knowing field internals.
- Cookie handling is a self-contained module
  (`web-search/cookies/`) with a barrel `index.ts`. The
  browser module has no cookie imports. The reader imports
  only from the barrel — never from internal cookie files.

### `index.ts` is for registration and wiring

Extension `index.ts` files declare state, register commands,
event handlers, and tools, then wire to other modules. They
should read as a table of contents.

**Event handlers** should delegate to named functions in other
files — enforcement in `enforce.ts`, transitions in
`transitions.ts`, etc. This prevents interleaving where five
concerns get shuffled by event registration order.

**Tool registration** is an exception. Pi's `registerTool` API
bundles `execute`, `renderCall`, and `renderResult` as part of
the registration call. Extracting those to separate files would
split one cohesive tool definition across modules. Keeping tool
bodies in `index.ts` follows the same pattern as the existing
tool extensions (`ask/`, `web-search/`, `pr-review/`). The
execute body should still delegate to other modules for
substantial work (showing gates, lifecycle changes) rather than
inlining all logic.

### One mutation site for command rewriting

`registerGuardian` is the single place that mutates
`event.input.command`. Individual guardians return a
`ReviewResult` (undefined, block, or rewrite) — they never
touch the event directly.

### Layered library structure

`extensions/lib/` is organized by domain:

- `lib/ui/` — TUI primitives (panels, gates, rendering, text)
- `lib/guardian/` — guardian pipeline (types, registration,
  review loop)
- `lib/parse/` — shell parsing (command utilities) and gh CLI
  domain modeling (separate files)
- `lib/state.ts` — session state helpers

UI primitives have no domain knowledge. Guardian and parse
modules depend on UI, not the other way around.

### Panel composition, not wrapping

`showPanel` and `showPanelSeries` have different return types,
different orchestration (immediate resolve vs async onSelect),
and different navigation (no tabs vs tabs). They compose the
same building blocks (`panel-state`, `panel-render`,
`panel-keys`) with their own orchestration. Do not make one
wrap the other — that forces one to carry complexity for the
other's use case.

### Idiomatic TypeScript

- Prefer type guards over `as` casts. Each `as` cast should
  be justified or replaced with a narrowing check. Exception:
  Pi's `renderCall` and `renderResult` APIs type `args` and
  `details` as `unknown` — casts there are acceptable since
  you're reading back what you just wrote.
- Use top-level `import` over inline `require()`. Use dynamic
  `import()` only when lazy loading is intentional.
- Every empty `catch {}` block must have a comment explaining
  why the error is safe to ignore. Silent swallowing without
  explanation is not acceptable.
- Every exported function has a JSDoc comment describing what
  it does (not how). Internal helpers need docs only when their
  purpose is non-obvious.
- Replace magic numbers with named constants.

## Linting

This project uses [Biome](https://biomejs.dev/) for linting and
formatting. **Run the linter after making code changes and before
committing:**

```sh
npm run lint        # check for issues
npm run lint:fix    # auto-fix what it can
```

All code in `extensions/` must pass `npm run lint` cleanly (no
errors, no warnings) before being committed. Fix the code to
satisfy the linter rather than suppressing rules.

## Testing Changes

Use `/reload` in a running pi session to pick up changes without
restarting. Use `pi -e ./extensions/some-ext` to test a single
extension in isolation.

## What Not to Do

- Do not add build tooling, bundlers, or transpilation steps.
- Do not add pi's own packages to package.json. They are
  provided at runtime (`@mariozechner/pi-coding-agent`,
  `@mariozechner/pi-ai`, `@mariozechner/pi-tui`).
  Third-party dependencies belong in `dependencies`.
- Do not create `.md` files directly in the `skills/` root
  (other than inside subdirectories).
- Do not introduce class hierarchies for guardians or modes.
  Use interfaces and composition.
- Do not merge PR and issue guardians into a shared factory.
  They are independently motivated.
- Do not add a shared base type for modes. Their runtime
  contracts differ (plan-mode intercepts writes, TDD-mode
  has a phase state machine). File naming convention is the
  right level of shared structure.
- Do not mutate `event.input.command` outside of
  `registerGuardian`. That is the single mutation site.
- Do not leave empty `catch {}` blocks without a comment
  explaining why the error is safe to ignore.
