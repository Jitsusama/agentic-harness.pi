## What This Is

A pi package: a collection of extensions and skills that other
people install into their pi setup. There is no build step and
no test suite. Pi compiles TypeScript at runtime. Most
extensions have no dependencies; exceptions (like
`google-workspace-integration`) carry their own `package.json`.

## Structure

- `extensions/`: TypeScript modules organized by behavioural
  contract (see Extension Categories below)
- `extensions/lib/`: shared library, organized by domain:
  - `lib/ui/`: TUI primitives (panels, gates, content
    rendering, text utilities)
  - `lib/guardian/`: guardian pipeline (types, registration,
    shell parsing)
  - `lib/github/`: GitHub domain (API, CLI, PR identity,
    diff, review)
  - `lib/state.ts`: session state helpers
- `skills/`: package-bound markdown instructions the agent
  loads on demand when a task matches their description
- `.pi/skills/`: project-local skills for developing this
  package (not shipped to consumers)

UI primitives have no domain knowledge. Guardian and GitHub
modules depend on UI, not the other way around.

## Extension Categories

Every extension has a contract suffix that identifies what
it does:

- **Guardians** (`*-guardian`): intercept shell commands and
  present a human review gate. Implement `CommandGuardian<T>`
  with detect → parse → review.
  `commit-guardian`, `pr-guardian`, `issue-guardian`,
  `history-guardian`

- **Interceptors** (`*-interceptor`): intercept shell commands
  and modify them silently, without a review gate.
  `attribution-interceptor`

- **Workflows** (`*-workflow`): orchestrate a multi-step or
  session-wide process with state and stages. This covers
  both persistent session workflows (planning, TDD) and
  task-scoped orchestration (PR review, PR reply).
  `plan-workflow`, `tdd-workflow`, `pr-review-workflow`,
  `pr-reply-workflow`, `pr-annotate-workflow`, `ask-workflow`

- **Integrations** (`*-integration`): bridge to external
  services via registered tools.
  `google-workspace-integration`, `web-search-integration`

- **Widgets** (`*-widget`): add UI elements to the interface.
  `content-viewer-widget`, `status-line-widget`,
  `panel-zoom-widget`

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
the `planning-guide` skill + `plan-workflow` extension) but
they all work independently.

## Conventions

- Each extension and skill directory has a README.md for
  humans.
- Extensions use JSDoc headers describing their purpose.
- Skills have a SKILL.md (loaded by pi) and a README.md
  (for browsing). Do not duplicate content between them.
- **Never put a README.md in the `skills/` root.** Pi treats
  any `.md` file there as a skill.
- Imports from pi use `@mariozechner/pi-coding-agent`,
  `@mariozechner/pi-ai` and `@mariozechner/pi-tui`. These
  are provided by pi at runtime; do not add them to
  package.json.

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
mutation directly. See `lib/guardian/types.ts` for the
contract.

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

### Keep Concerns in Their Domain

Each module should own its concern and nothing else. When a
helper is used by multiple domains, it belongs in the shared
library at the level that matches its concern, not in the
first domain that needed it.

Barrel exports (`index.ts`) define the public surface of a
module. Consumers import from the barrel, never from
internal files. The cookies module in `web-search-integration`
is a good example: the browser module has no cookie imports,
and the reader imports only from the barrel.

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
npm run lint:fix    # auto-fix, then verify
npm run lint        # confirm no remaining issues
```

Always run `lint:fix` first. Biome's auto-fixes are safe for
this project (import ordering, formatting), so there's no
reason to check before fixing. All code in `extensions/` must
pass `npm run lint` cleanly (no errors, no warnings) before
being committed. Fix the code to satisfy the linter rather
than suppressing rules.

## Testing Changes

Use `/reload` in a running pi session to pick up changes without
restarting. Use `pi -e ./extensions/some-ext` to test a single
extension in isolation.

## What Not to Do

- Do not add build tooling, bundlers or transpilation steps.
- Do not add pi's own packages to package.json. They are
  provided at runtime (`@mariozechner/pi-coding-agent`,
  `@mariozechner/pi-ai`, `@mariozechner/pi-tui`).
  Third-party dependencies belong in `dependencies`.
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
