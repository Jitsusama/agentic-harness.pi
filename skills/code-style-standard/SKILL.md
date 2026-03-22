---
name: code-style-standard
description: >
  Personal code design and style preferences. Readability,
  cognitive load, naming, structure, abstraction, testing
  and domain-driven design. Use when writing or modifying
  code in any language.
---

# Code Style

This skill defines how code should look and feel when we
write together. It applies to every language and every
codebase we touch. The preferences here are mine; when you
write code on my behalf, it should feel like something I
would actually write.

The overarching goal is craftsmanship. Code should be
readable, clean, easy to understand and kind to the reader's
cognitive load. Every decision we make should serve that
goal.

## Language Idiom Trumps All

This is the single most important rule in this entire skill.
**Follow the idioms of the language being written in.** If a
language's conventions conflict with anything stated here,
the language wins. Fighting a language is a losing battle,
and the code should feel comfortable to someone fluent in
that language.

Go's verbose error handling uses intermediate variables;
that's fine. Python's conventions lean toward classes and
duck typing; lean into it. Ruby has `.tap` and blocks; use
them when they're clean. The preferences below are a
starting point, not a straitjacket.

## Codebase Consistency

The second most important rule: **match the existing
codebase.** If the project has established patterns, follow
them even when you'd personally prefer something different.
The principle of least surprise matters more than personal
taste. Nobody should read our code and go "what the hell is
this doing here?"

When the codebase has no established pattern for something,
then these preferences apply in full.

## Read Before You Write

Before introducing new code, study the codebase it's going
into. Look at neighbouring files. Search for similar
patterns. Understand how the project already solves the
kind of problem you're about to solve.

If the project has explicit instructions for contributors
(an AGENTS.md, a style guide, architecture docs), defer to
them; they describe the established patterns. But even with
explicit instructions, look at the actual code nearby to
build confidence that you're matching the real patterns, not
just the documented intent. Documentation drifts;
code doesn't lie.

This isn't optional ceremony. It's how you earn the right
to add code that feels like it belongs.

## Principle of Least Surprise

Nobody should read our code and feel confused about what
something does, where something lives or what happens when
they call a method. The principle of least surprise is the
connective tissue between nearly every other preference in
this skill: naming, encapsulation, composition, ordering,
return types and side effects all serve it.

### Names Must Match Behaviour

A method called `save` should persist something. A method
called `find` should return nil or an optional when the
thing isn't found, not throw an exception. A method called
`validate` should check correctness, not mutate the object.
Classes should do what their name naturally suggests, and
code within a function should make sense given the
function's name.

When a name promises one thing and the code does another,
the reader's trust breaks. Every subsequent line gets
scrutinized instead of understood.

### Side Effects Must Be Obvious

Mutations and I/O should only happen in methods whose names
clearly signal them. A getter should not mutate state. A
constructor should not perform I/O. A method that looks
pure from its signature should not write to a database
behind the scenes.

Side effects are dangerous because they violate the
reader's ability to intuit what code does. Sometimes they're
genuinely necessary, but that ground should be tread
carefully and the name should leave no doubt about what's
happening.

### Things Should Live Where They Belong

A class, a method, a constant, a module: each one should
live in the place where a reader would naturally look for
it. If someone familiar with the domain would be surprised
to find something where it is, it's in the wrong place.

## Vertical Space

Vertical space must be earned. Every blank line, every extra
statement and every line of ceremony that forces the reader
to scroll needs to justify its existence. Scrolling is
hostile to comprehension; the more code fits on one screen,
the more the reader can hold in their head at once.

Do not initialize a variable, set it, then return it as
three separate statements when a single expression would do.
Return the result of an expression directly. Use the
language's idioms to avoid pointless intermediate variables:
comprehensions in Python, method chaining in Ruby or
JavaScript, pipelines in Elixir. Pointless intermediate
variables are the enemy.

That said, blank lines within a function are like paragraphs
in a chapter. They have a place when they separate genuinely
distinct logical steps, but they also break a chain of
thought. Use them deliberately and sparingly. If a function
feels like it needs several blank-line-separated sections,
that's often a sign it's doing too much or its variables
should be organized differently.

## Line Length

Aim for **80 characters** as the ideal. In practice, **100
characters** is the practical limit that keeps code readable
without stuttering. Going up to 120 is acceptable on rare
occasion, but there needs to be a good reason. Horizontal
scrolling is just as hostile as vertical scrolling.

## Functions and Methods

### Size

The human brain can only hold so much in working memory at
once. A function should fit on a single screen so the reader
can tokenize the entire thing without scrolling. A long
method is a smell; it almost always means the function is
doing too much. Well-organized functions let the brain group
related lines into chunks; poorly organized ones force
constant context-switching.

### Single Responsibility

Every function should do one thing. If you find yourself
wanting to add a section comment inside a function to label
what the next block does, that block probably wants to be
its own function.

### Ordering

Methods should tell a narrative. Public methods come first,
followed by the private helpers they call. Top-down ordering
(newspaper style) is the default: the reader encounters a
high-level method, then can scroll down to find the details
in the order they were referenced. This works most of the
time; deviate only when a different grouping genuinely reads
better.

### Expression-Oriented Style

Prefer returning the result of an expression over assigning
to a variable and returning it. Prefer method chains when
they read cleanly. Prefer ternaries when they're simple and
readable; abandon them the moment they get complex. The
guiding principle is that the reader should be able to
follow the data transformation in one fluid motion.

### Clarity Over Cleverness

Idiomatic cleverness is welcome. A well-known language
idiom that happens to be terse isn't "clever"; it's fluent.
Python's `defaultdict`, Ruby's `&:symbol`, a clean
destructuring pattern: these are the language speaking
naturally, and using them shows fluency rather than
showing off.

Algorithmic or structural cleverness that sacrifices
readability for performance or brevity is a different
story. A bitwise trick that saves three lines but requires
a comment to explain what it does is not an improvement.
When two approaches exist, prefer the one a newcomer to
the codebase would understand on first read. The only
exception is when performance genuinely demands the clever
path, and in that case, a comment explaining why the
readable version wasn't fast enough is the price of
admission.

## Naming

### Domain Language

Name everything according to the problem domain it tackles.
Use language congruent with that domain so that people
familiar with it would naturally understand the code because
it speaks their language. `validateOrder` over
`processData`. `resolveConflict` over `handleStuff`.

### Length

Use the shortest name that still communicates effectively.
Long names are sometimes necessary, but defaulting to
verbosity is a smell; it often means the thing is doing too
much. On the other hand, short names that force the reader
to look up the definition increase cognitive load. Context
helps: `remaining` is perfectly clear inside a `RetryPolicy`
class; it would be ambiguous as a top-level variable.

### No Utility Modules

The existence of a utility module is a smell. They're a
dumping ground for concepts that weren't given a proper
home. They have no cohesive responsibility, so anything
that doesn't fit elsewhere gets tossed in. They become
attractors for unrelated code and grow without bound: the
junk drawer of the codebase.

When you extract shared code, you should be extracting a
concept and an abstraction, not tossing loose functions into
a grab bag. Name the thing, give it a logical home and let
it live where it belongs.

## Conditionals and Control Flow

Guard clauses and early returns are preferable to deeply
nested conditionals. Make the early exits obvious and clean
so that the body of the function is focused on the happy
path without being wrapped in a conditional block.

Nested conditionals smell. They often indicate overlaid
responsibilities that need to be separated. When you see
three levels of nesting, stop and think about whether the
function is trying to do too many things at once.

Single-expression guard clauses without braces can be
beautifully clean when the language supports them. Use them
when they read well. Switch statements are excellent when
branching off a single value. Pattern matching is sublime
when it's idiomatic and supported by the language.
Readability is the tiebreaker in every case.

## Parameters

Prefer named parameters over positional ones when the
language supports them. They reduce the need for code
comments and make callsites self-documenting.

The smell lives at the callsite, not the definition. If
someone reading the calling code isn't sure what an
argument means, that's the signal. A positional `true` or
a bare integer at a callsite is a readability hazard;
named parameters, enums or a small configuration type make
the intent obvious without requiring the reader to look up
the method signature.

When a parameter list grows daunting, there are two
possible causes and they demand different responses.
Sometimes the parameters are related and want to be
grouped into a type that carries meaning in the domain
(a "shipping address" rather than five string parameters).
Other times the function is simply responsible for too
much and the parameter list is the symptom, not the
disease. Distinguish between the two rather than
reflexively wrapping everything in a parameter object.

## Comments and Documentation

Comments need to be earned. Don't add them because you can;
add them when there's context not present in the code itself
that the reader needs in order to understand the *why*. If
the code is well-named and well-structured, most comments
are redundant noise.

### Inline Comments

When an inline comment is warranted, it should be a
complete sentence with a subject and a verb. It's
explaining *why* something works the way it does, and that
explanation deserves the same grammatical care as any other
prose.

**Good** (complete sentence, explains why):
```
// We cap it to terminal width so prose stays readable.
```

**Bad** (fragment, missing subject):
```
// Cap to terminal width for readability.
```

Short functional markers like `// fallback` are fine as
labels. They're naming a thing, not expressing a thought.

**Don't write section-divider comments** like
`// ---- Constants ----` or `// Helpers`. If a file needs
section labels to be navigable, it has too many
responsibilities and should be split. The code's structure
should make the organization obvious without signposts.

### Doc Comments

Doc comments on public interfaces aid the reader and
contribute to the domain language. Add them when the
codebase has a pattern for it, or when starting a new
codebase where establishing that pattern makes sense. When
the codebase doesn't have doc comments, don't introduce
them unilaterally.

When you do write them, make them warm and explanatory,
not terse metadata. Instead of "Plan mode lifecycle:
activate, deactivate, toggle, persist and restore," write
something like "Manages the full lifecycle of plan mode:
turning it on and off, toggling between states, and
persisting settings across sessions so nothing gets lost."

## DRY and Duplication

DRY only matters when code is duplicated for the same
reason. Sometimes two pieces of code look identical but
exist for different reasons that just happen to overlap
today. These should remain separate, because their reasons
for change can diverge. Coupling them together leads to
janky code full of conditionals trying to keep shared logic
working for increasingly different use cases.

When you *do* extract shared code, extract a concept, not
just a function. Give it a name that communicates what it
represents. Start close to where it's used and only move it
outward as the audience expands.

## Abstraction and Responsibility

### Just-in-Time Abstractions

Don't abstract speculatively. Build the interface you need
now. When it no longer fits, redesign it; we have tests to
protect us. That said, an abstraction that's obviously
handling too much from the start is a problem. Use
judgement: the goal is pragmatic design, not premature
generalization.

### Focused Responsibilities

Every module, class and abstraction should have a clear,
well-defined responsibility. New code added to it should
fit naturally into that responsibility. We don't want a
thousand tiny classes, but we also don't want god objects.
When a responsibility grows too large, split it. Name the
pieces well and let each one serve a clear purpose.

### Composition Over Inheritance

Always prefer composition. Inheritance violates the
principle of least surprise; it hides behaviour in parent
classes and forces the reader to trace through an entire
class hierarchy, potentially across multiple files, just to
understand what a single method actually does. The mental
model explodes: instead of reading one piece of code, you're
reconstructing a chain of overrides, super calls and
inherited state. Compose focused, well-named collaborators
instead. Each collaborator is self-contained and can be
understood on its own terms.

### Levels of Abstraction

A method that mixes high-level orchestration with low-level
detail is a smell. It forces the brain to context-switch
between different levels of thinking, tokenizing some blocks
as broad strokes and others as fine detail. Keep each
function at a consistent level of abstraction. When you spot
a block of low-level code inside a high-level method,
extract it into a well-named helper.

## Consumer-Driven Design

Every interface should be designed from the perspective of
the code that will consume it. Before deciding on a method
signature, ask what the calling code wants to see. Before
choosing a return type, ask what would make the caller's
life easiest. Before organizing a module's public surface,
ask what would be a joy to use.

This applies at every scale. When designing a public API or
a package boundary, consumer ergonomics is paramount:
method signatures should read naturally, return types
should compose well, and the module hierarchy should make
discovery intuitive. But it also applies to private helpers
within a class. The calling code is always the consumer,
even when the consumer is you three lines up.

In codebases that favour outside-in development (writing
the calling code or test first, then building the
implementation to satisfy it), follow that pattern. In all
codebases, apply the mindset even when you aren't writing
the calling code first. Imagine the callsite, then design
the interface that would make that callsite clean and
obvious.

## Domain-Driven Design

Naming everything in domain language, protecting boundaries,
and organizing code around business concepts are not
optional. Domain-driven design is the natural companion to
every other preference in this skill.

### Screaming Architecture

When we have control over organization and aren't fighting
the language or framework, the directory structure should
scream the domain concepts. Someone opening the project
should immediately see what it's about, not what framework
it uses.

That said, never fight an idiomatic organization pattern.
Rails screams its framework and that's fine; fighting it
never pays. Where we do have control, domain concepts rule.

### Bounded Contexts and Anti-Corruption Layers

Don't leak implementation details across abstraction
boundaries. Write to interfaces at domain boundaries to
build out the domain language and provide an anti-corruption
layer. Changes should be localized to the things that should
change; incidental changes in unrelated areas are a smell of
a leaky abstraction.

## Encapsulation and Visibility

Be selective about what you expose as public. Public
interfaces *will* get used, whether you intend them to or
not. The less you expose, the more freely you can refactor
without breaking consumers. Default to private and only
promote to public when there's a genuine need.

In languages where visibility is convention-based (like
Python), follow the convention. The principle is the same:
communicate intent about what's meant to be used externally.

## Immutability

Value objects (money, coordinates, date ranges, addresses)
should always be immutable. They represent snapshots or
measurements; there's no meaningful sense in which a dollar
amount "changes." You create a new one.

Entities with a lifecycle (an order that moves through
statuses, a user whose profile evolves) can mutate, because
what they represent genuinely changes over time. Even then,
the entity should encapsulate immutable value types where
it makes sense: an order's shipping address is a value
object even though the order itself is mutable.

The test is simple: does this thing represent a fixed value
or a snapshot? Make it immutable. Does it represent
something with a lifecycle that changes over time? Let it
mutate. Is it mutable just because that's more convenient?
That's the wrong reason.

Don't chase immutability into performance-critical paths
where it causes real harm, and don't fight a language that
isn't built for it. Pragmatism over purity, always.

## Error Handling

Follow the language's idiomatic error handling patterns.
Result and optional types are lovely in languages that
support them. Exceptions are fine in languages built around
them. Nil returns should only happen when nil is a
meaningful value for the data being returned, not as a
stand-in for "something went wrong."

Handle errors less often rather than more. Don't catch an
error, wrap it in a new type and rethrow it at every layer.
The only time re-wrapping is justified is when crossing a
domain boundary where the error needs to be translated into
the consuming domain's language.

## Defensive Coding

Validate at boundaries. Trust contracts internally. If data
enters from outside the system (user input, external APIs,
deserialized payloads), validate it thoroughly at the point
of entry. Once it's inside a zone of trust, stop checking
it; redundant null checks and defensive assertions in
private methods add noise without adding safety.

Identify zones of trust and be intentional about where the
boundaries lie.

## Functional Patterns

Functional patterns (map, filter, reduce, pipelines,
higher-order functions) are beautiful when they read cleanly
and are idiomatic in the language. Prefer them over
imperative loops when both work and the functional version
is at least as readable. Don't use them as a bludgeon; when
an imperative loop is simpler and clearer, use the loop.

## Concurrency and Async

Prefer sequential, imperative code by default. It's easier
to reason about, easier to debug and easier to trust.
Async and concurrent patterns should be introduced when
performance or reliability genuinely demands them, not
because they feel modern or because the language makes them
easy to reach for.

When async is needed, use the language's idiomatic approach.
Async/await over callbacks. Structured concurrency over raw
threads. The goal is to make the concurrent code as close
to readable sequential code as the language allows.

## Magic Values

Magic numbers, strings and booleans should be extracted into
named constants or helper methods when they encode a domain
concept. If a value represents something meaningful in the
domain language, give it a name.

Don't extract values into constants that just repeat the
value's name; that adds indirection without adding meaning.
Use discretion. Boolean parameters are a particular
readability hazard: `doThing(true, false)` communicates
nothing. Named parameters, enums or a configuration object
are almost always better.

## File and Module Organization

Every file should have an overarching responsibility. Having
a file serve as a dumping ground for unrelated classes or
functions is a smell (unless we're writing a script, where
that's expected).

In languages where grouping related classes in a single file
is idiomatic, that's fine. The test is whether the file has
a coherent reason to exist, not whether it contains exactly
one class.

Follow the language's and framework's idiomatic
organization. Where we have control, screaming architecture
applies: organize by domain concept, not by technical layer.

## Testing

### Behaviour Over Implementation

Tests verify *what* the code does, not *how* it does it. If
a test would break when the implementation changes without
the behaviour changing, it's testing the wrong thing. If you
find yourself needing a test solely to cover an internal
edge case in the implementation, that's a smell; rethink the
design so that the edge case either surfaces as a meaningful
behaviour or disappears.

### Structure

Use Arrange/Act/Assert (or Given/When/Then) structure. Don't
label the sections with comments; separate them with a blank
line so the structure is visible without noise. This is one
of the few places where vertical whitespace between sections
is not just acceptable but encouraged, as it makes the
three phases immediately recognizable.

That said, when the test is so simple that the structure is
obvious in two or three lines, don't add whitespace just for
ceremony. Bulky test methods that are mostly whitespace
defeat the purpose.

### Naming

Test names should be readable, consistent and function as
documentation. They should communicate the behaviour from
the perspective of the functionality being tested, helping
the reader connect with what the subject under test exists
for. Keep them concise but complete enough that someone
reading just the test names gets a clear picture of the
contract.

### Ordering

Within a test module, order tests to tell a story. Happy
path first, then edge cases, then error cases. This gives
the reader the full picture of what the code is *for* before
showing them the boundaries and failure modes.

### Quality

Test code is held to the same standard as production code.
It needs to be readable, well-named, well-structured and
free of unnecessary complexity. Test helpers are for the
setup that isn't important for understanding the design; the
test body itself should clearly show the interface and the
behaviour being verified.

### Flat Over Nested

Prefer flat test lists over deeply nested describe blocks.
Heavy nesting obscures the tests behind the organization.
When grouping adds genuine clarity (e.g., a describe block
for a specific method), use it; when it's just ceremony,
keep things flat.

### Test Doubles

Mock at domain boundaries; don't mock internal
collaborators. When you mock everything a class touches,
the tests become a mirror of the implementation: they
break whenever you refactor, even when behaviour hasn't
changed.

Stub external dependencies when you need to simulate
scenarios (a network failure, a specific response payload).
Use real collaborators or purpose-built fakes when
verifying that two pieces integrate correctly.

Don't get hung up on the unit vs integration taxonomy.
Every test integrates something, even if only the standard
library. A "unit" is whatever size provides valuable, fast
feedback. The meaningful boundary is the public contract:
assert across it, and let the internals remain free to
change.

## Dependency Injection

Only use dependency injection in languages that require it
for testability. If the language supports mocking or stubbing
without DI (implicit interfaces, monkey patching, module
replacement), don't introduce DI framework machinery. It
adds complexity that buys nothing when the language already
gives you the tools to test effectively.

When DI is needed, prefer the simplest form that works:
constructor injection or passing collaborators as parameters.
