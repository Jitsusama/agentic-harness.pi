# Design Principles

The reasoning behind the rules [AGENTS.md](../AGENTS.md) states in
a line each.

The code should read like a description of what the system
does, not how it wires things up. Every module should use
idiomatic TypeScript, handle errors honestly and serve as an
example of clean Pi extension code.

## Split by Responsibility, Not Line Count

A 300-line file that does one cohesive job is fine. A 150-line
file with three interleaved responsibilities should be split.
The question to ask is whether the file has multiple reasons
to change, not whether it's long.

## Composition Over Inheritance

Shared behaviour uses types and helper functions, not class
hierarchies. Each guardian is a plain module that implements
the shared interface; a registration helper wires it into
Pi's event system. Workflows share a file naming convention
but no base type because their runtime contracts differ.

## Guardian Pipeline: detect → parse → review

Every guardian follows the same three-step pipeline:

1. **detect**: does this command match? (fast, no parsing)
2. **parse**: extract structured data from the command
3. **review**: present the data for human review, return a
   result (undefined to allow, block, or rewrite)

A new guardian implements the shared interface and calls the
registration helper; it never touches event wiring or command
mutation directly. See `lib/guardian/` for the public contract
(downstream packages import from `./guardian`).

## Guard Policy

Every guard in the package, guardian, interceptor, quest gate or
tool confirmation, declares a class (approval, form or safety)
and runs under a mode: off, redirect or block. Block is a panel
for an approval and a refusal, every time, for anything else.
Redirect is what makes most of them cheap without teaching
nothing: a refusal reaches the agent in its own tool result with
its remedy, and the same call made again unchanged goes through
as an override the person sees, so a wrong guard cannot corner
the agent. An approval under redirect goes ahead and shows the
person what it would have asked. Off lets everything through and
shows the person what the guard saw; nothing a guard sees is
silent. The former `report` mode, which let a refusal through
and told only the person, is read as off: the agent never heard
it and so repeated the mistake.

The defaults follow one rule: block where a mistake reaches
somebody else, cannot be undone, or has one right form, and
redirect everywhere else. So the commit, PR, issue and review
approvals redirect, Slack and Google block, the PR, issue and
commit form guards block, the quest's write gates redirect, and
safety blocks only the irrecoverable.

Each extension declares its own guards when it loads, from the
one catalogue in `lib/internal/guardian/guards.ts`, so the
defaults hold whether or not `guard-policy-workflow` is
loaded. A guard nobody declared resolves to block, which is
what keeps a downstream guardian that predates the policy
working as it did. A guardian opts in by passing `declaration`
to `registerGuardian`, and its review receives the mode; a
refusal goes through `refusalUnder` and a confirmation through
`asksUnder`, both in `lib/guardian/apply.ts`. Never read a mode
and branch on it by hand: those two are what keep an off guard's
report, a redirect and a blocking guard's refusal the same text,
and what remember a redirect for its override.

## Workflow File Convention

Each workflow extension uses these files:

- `state.ts`: state interface and initial/default values
- `lifecycle.ts`: activate, deactivate, toggle, persist,
  restore
- `enforce.ts`: tool_call interception: what gets blocked,
  what gets allowed and why
- `transitions.ts`: confirmation gates, context injection
  and superseding context that has gone stale
- `index.ts`: registration only: declares state, registers
  commands/shortcuts/flags, wires other modules to pi events.
  Should read as a table of contents for the extension.

Not every workflow needs every file; merge neighbours if a
file would be trivially small. But the naming convention is
what tells readers where to find each concern.

## The Prompt Is Append-Only

The provider caches the prompt as a prefix: tools, then the
system prompt, then the conversation. Changing any byte of it
re-writes everything after that byte at the cache-write price,
which under one-hour retention is forty times a read on Opus
5.5. So an extension never edits what a request has already
sent. It does not re-render state into the system prompt on
each prompt, and it does not filter or rewrite earlier messages
from a `context` hook. State that changes is said as a new
message (`before_agent_start` can return one), and context that
has gone stale is superseded by a message saying so, never
removed. For state the model should always know, register a
standing context (`registerStandingContext` in `lib/prompt`,
exported as `agentic-harness.pi/prompt`): it freezes the text
into the system prompt once per session and says each change
as a message. Over a month the two patterns this replaced, a quest
line re-rendered into the system prompt and TDD reminders
filtered out once a loop ended, cost about $600 at list in
rewrites that told the model nothing new. There is no exception:
a demotion workflow that rewrote old tool results in batches
was removed on 2026-09-24, since it never ran outside shadow and
its whole stake was about $300 a month.

## Don't Merge Things That Merely Converge

Two modules that happen to look similar today aren't
necessarily the same abstraction. PR and issue guardians
share a shape via `CommandGuardian` but aren't merged into a
factory; they're independently motivated and could grow
separate concerns. When deciding whether to deduplicate, ask
yourself: are these the same concept, or just coincidentally
similar right now?

## A Large Answer Is Stored, Not Truncated

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

## Keep Concerns in Their Domain

Each module should own its concern and nothing else. When a
helper is used by multiple domains, it belongs in the shared
library at the level that matches its concern, not in the
first domain that needed it.

## Public Library vs Internal Code

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

## Integration Architecture

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
noticed. agentic-harness.core's `tests/web/purity.test.ts` walks the
import graph and fails when an analysis barrel reaches something
heavy.

## `index.ts` Is for Registration and Wiring

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

## One Mutation Site for Command Rewriting

The guardian registration helper is the single place that
mutates `event.input.command` for guardians. Individual
guardians return a result (undefined, block, or rewrite);
they never touch the event directly. The history guardian's
lease of a bare `git push --force` is a rewrite, and lands
there like any other.

Interceptors are the second sanctioned mutation site.
They mutate `event.input.command` silently (no review
gate) because that's their contract: transparent command
enrichment.

## Idiomatic TypeScript

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
