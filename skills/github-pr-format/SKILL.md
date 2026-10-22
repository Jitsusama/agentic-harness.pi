---
name: github-pr-format
description: >
  PR descriptions for a reader who will not read the code: the
  four sections (TL;DR, Problem, Solution, Validation), what
  each must do and how long it may be, and titles. Use when
  writing or editing a pull request description.
---

# Pull Request Writing

## Who Reads This

Write for a teammate who knows the product well but has not seen
this change, was not in the session that produced it, has two
minutes, and will not open the diff. Almost every line here is
written by an agent, so the description is how a person decides
whether they are aligned with the change and how far to trust it.
It is also the record somebody reads a year from now. If they have
to read the code to understand the description, it has failed.

That reader is an expert on the product and a newcomer to the
change. So do not explain what the product already does, but do
explain everything new: the new behaviour, how it works, the
choice you made. When you are unsure whether something new needs
a sentence, give it one; an expert loses less from one sentence
too many than from one missing.

Most readers read the TL;DR and stop, and the better the TL;DR,
the fewer read on. Whatever a reader must not miss goes there.

The reader asks four questions, in this order, and the four
sections answer them:

1. What is this? (TL;DR)
2. Why was it needed? (Problem)
3. What did you do, and why this way? (Solution)
4. What was checked, what was not, and what should I watch?
   (Validation)

## Title

- Describe the value, not the implementation.
- Not conventional commit format; use descriptive titles.

See `github-cli-convention` for title formatting rules
(Title Case, length, formula).

## Body Structure

A PR description has exactly four sections, in this order. Each
heading is the emoji and the name together, written precisely as
shown. The set is closed: no other headings, no optional ones.

The word limits below are ceilings, not targets. Most changes
need well under half of them. Say what the reader needs and stop.
A count made by feel lands either side of where it aimed, so aim
for about three quarters of a ceiling: written to the ceiling
itself, about one TL;DR in seven came back refused.

### 💡 TL;DR

The eight-second version, about 30 words and at most 40, in one or
two sentences.
The first sentence is a headline that stands on its own: it opens
with the thing that changed (never "This PR" or "This change") and
says what is different once this merges and for whom. Lead with what
a person notices (a faster start, a refusal that no longer happens),
then how. If the change does two independent things, the headline
names both. The second sentence, if there is one, carries what the
reader most needs next: the key decision, or a limit that changes
how far the first sentence can be trusted. If the checks cover less
than the headline claims, the TL;DR says how far they reach; a limit
goes there only when it narrows the headline. No code spans, file
names, links, bullets or bold. Write it last and lift it from the
other three sections. Every qualifier the Solution attaches to a
claim travels with it ("where the provider honours the signal",
"unless an undeclared guard"); if the qualifier will not fit, drop
the claim from the TL;DR, never the qualifier. A number keeps its
exact meaning and conditions: "offered back 29 of 29" is not
"restored 29 of 29".

### 🧩 Problem

Why the change exists, as what is wrong or missing compared with
what the reader already knows: what failed, for whom, and how we
know (a count, an incident, an error somebody saw). Do not tour
the subsystem; the reader knows it. If the reader would likely
assume the wrong cause, or the change reverses something they
rely on, say so outright: "it looks like X; it is actually Y,
because Z". Prose only, at most 120 words and three code spans.
It describes the world
before this PR, never the fix.

### 🔧 Solution

What the change does about the problem, as behaviour and the
mechanism that produces it. Open with a sentence of prose that
answers the Problem and says how: when what happens, what now
follows, and why that fixes it. A component name and its purpose
("adds a guard for X") is not an explanation; say what the guard
does and when.

Where you made a real choice that a reviewer might question, state
it as a contrast in prose: what you chose, what you turned down,
and the one thing that decided it ("one retry rather than a loop,
because a server that keeps dying should show as an error"). When
the choice gives something up that the change itself shows, say
what ("so a second blip in a row still fails"); reviewers ask that
first. Never invent a cost, and do not invent an alternative where
there was no real choice.

Then say what anybody will notice or has to do: a breaking change,
something now refused or removed, a new or changed setting or
default, a dependency, a migration. Name each one exactly as the
reader will meet it: the full config key path and every key the
section accepts, the command or script, the CI job, the new tool or
extension and its parameters, every extension (by its directory
name), command or export removed, a change to when or where
something runs (a CI trigger, a hook), the dependency and its new
range. Call a breaking change breaking. This is what code spans are
for, and these are never the part you cut.

Name the exceptions. For each behaviour you claim ("Escape now
stops a tree cut", "each wait has a clock"), look in the diff for
the path where it does not hold: a case left as before, a
fallback, a provider that has to opt in, an input that is
rewritten rather than refused. Say it in the same sentence ("stops
a tree cut where the provider honours the signal, as built-in git
does"). A claim with its exception is still short; a claim without
it is false.

Bullets are for parallel behaviours only, at most five, one
behaviour each, opening with the words that tell them apart (not
a column of "Adds..."). Never a list of artifacts: no "Docs:",
"Tests:" or "Files:" entries. If the change has more
independent parts than five bullets can hold, name the rest in one
"Also:" sentence; a change that cannot be described this way
should probably be split. At most 200 words and eight code spans.

### 🔬 Validation

Three short moves, in this order:

1. **Checked:** what ran and what it showed, for each claim about
   behaviour: a test, a command, a live run, a CI job, and its
   result ("a new test reproduces the hang, fails on the old code
   and passes now"). Coverage is not a result: "the new tests cover
   X" says only that tests exist, so say they ran and what they
   showed. Name every check as the reader would rerun it: the
   command (`pnpm lint`, `pnpm typecheck`), the test directories or
   the named test, and the count when you know it ("the 813 tests in
   tests/quest and tests/package pass"). A check the reader cannot
   identify ("the touched tests", "the two flaky tests") proves
   nothing to them. Say what each one showed, not what it covers.
2. **Not covered:** where the checks above stop, stated as a fact
   about the checks rather than a claim about yourself: what a
   stand-in replaces, which case no test reaches, and what that
   leaves open ("the tests replace the server with a stand-in, so a
   real crash is not exercised"). Read it off the tests and the
   commands that ran. Say you did not run something only when you
   know you did not; never guess, and never add a limit to look
   careful. A limit inferred from evidence you cannot see ("a real
   reload is not exercised", when you simply have no record of one)
   is the commonest invented claim: if you do not know what was run,
   say only what the tests in the change do and do not reach. Speak
   about the checks you named, not the whole suite: "the two new
   tests do not reach X", never "no test reaches X", since you have
   not read every test. If the checks reach everything the Solution
   claims, leave this move out.
3. **Watch** (only when there is something to watch): an
   observable signal after merge that would show the change is
   wrong, such as an error message or a count, that the change
   itself makes visible. Name the signal only; do not guess at what
   would cause it, and leave Watch out rather than invent one.

Add no fact the diff, the commits or what you ran do not show: no
platform ("on Linux and
macOS"), no cause, no proportion ("mostly"), and no stronger word
for a weaker one ("billed" for "reported", "restored" for
"offered"). A plausible detail you supplied is the error a careful
reader finds first.

Give counts with their denominator ("12 of 14 call sites") and
before-and-after values rather than percentages alone. No hedges
("should work", "likely", "seems") and no assurances ("thoroughly
tested", "robust"). At most 100 words and five bullets. Code spans,
commands and short output excerpts belong here when they help.

## Writing for a Person

These are what make the four sections readable rather than merely
present.

- **Give the count or name the set.** Scope is what the reader
  will act on, so be exact about it: "7 of the 9 guards", "the
  three billing prompts", "every guard except the commit one".
  Readers take "guards now check X" or "most guards" to mean
  nearly all of them. When you have to cut words, leave a thing
  out; do not widen a claim to cover it.
- **Keep the reasons.** Cut whole items before you cut "because",
  "so", "instead of" or "which means". Expert readers follow a
  chain of cause and effect faster than a list of claims, and a
  list without its reasons hides the very thing they would
  question.
- **Explain, then list.** A problem and its solution told as cause
  and effect is remembered far better than a list of facts about
  a topic. Bullets are for parallel items, not for saying why one
  thing leads to another.
- **One concrete case.** Where a rule is abstract, give one
  instance: a specific input, what used to happen, what happens
  now. If you cannot produce one, the rule is probably overstated.
- **Behaviour over artifacts.** Say what a person sees or can now
  do, not which module moved. Name an identifier only when the
  reader will type it or set it, and put it in a code span.
- **The reader was not in the session.** Names you coined while
  working ("phase 2", "option B", "the shim") mean nothing to
  them. Use the product's own term, or say what the thing is the
  first time. Never point at the conversation ("as discussed",
  "per the plan").
- **Plain words.** Jargon and needless long words cost a reader's
  trust even when they are defined. Use the word the reader would
  use. No sentence may pass 40 words; keep each under about 30.
- **Numbers that mean something.** "Merging failed 23 times in two
  months" tells the reader something; "1,353 tests pass" mostly
  tells them the suite is large.
- **Nothing you cannot show.** Every claim, including every limit,
  has to come from the change, its commits or what you ran. A
  plausible detail you inferred is still invented, and one wrong
  detail costs the reader's trust in all the right ones. That holds
  for limits too: describe where the checks stop, which you can
  read off the tests, rather than what you did not do, which you
  may not know.
- **No selling.** Leave out "seamless", "robust", "comprehensive"
  and "significantly" unless a number stands behind them.
- **The change as it stands.** Not the history of reaching it:
  leave out what was tried first, who found each fix, review
  rounds and commit mappings. When a PR grows, rewrite the
  description to fit the whole change.

## Before You Submit

The tool checks what can be counted: the headings, the lengths,
no code in the TL;DR. It cannot check whether a sentence is true,
and a description can pass every check while saying something
false. So read the draft once more as the reviewer, and answer
these before you send it. Each one is a mistake that passes the
checks and costs the reader's trust.

1. **Does the Solution back every claim in the TL;DR, with the
   same reach?** Put the two side by side. If the Solution says
   one path is refused and another only warned, the TL;DR cannot
   say "refused". Summaries drift wider than what they summarise,
   and the TL;DR is the part most readers read alone. Narrow the
   TL;DR; never widen the Solution to match it.
2. **Does every behaviour you claim hold on every path?** For each
   "now does X", find the case in the diff where it does not: an
   exception, a fallback, an opt-in, a rewrite. Name it or narrow
   the claim. Then: is every "all", "every", "most", "always",
   "never" and "only" literally true? Ask whether you could list the
   set it covers. "After every test" is fine; "every guard" when two
   are exempt is not. The same goes for claims with no such word: a
   plain "X is refused" reads as always.
3. **Is anything the reader must act on missing?** List them to
   yourself: a breaking change, something that now fails or is
   refused where it used to pass, something removed, a new or
   changed setting or default, a new tool, command or CI job, a
   dependency, a migration, a test seam others must now use. Each
   one belongs in the Solution by the name the reader will type,
   however short you are on words.
4. **Does the key decision say what it cost, if the change shows a
   cost?** Many choices give something up; some do not, and an
   invented cost is still an invention. If the reader would weigh
   the trade differently, they need to know what was traded: "one
   retry rather than a loop, so a lasting failure shows as an error
   instead of recovering".
5. **Can the reader reach every piece of evidence?** Name the
   test, command or CI job, or link the document a number comes
   from. A figure from something only you can see is a claim the
   reader has to take on faith.
6. **Can you point at the line that shows each claim?** The diff,
   a commit message or output you ran. If you cannot, cut the
   claim. A plausible inference is still an invention.
7. **What would the reviewer ask first?** If the answer is not in
   the description, put it there, or cut something less useful
   to make room.

## Issue and Stack Context

When an issue tracks the work, add a line linking to it straight
after the TL;DR text, inside that section:

```markdown
Part of #ISSUE_NUMBER
```

When no issue tracks the work, omit the line. Never invent a
number, and never reach for a nearby issue that happens to be
open.

When a PR is part of a stack (based on another PR or has PRs
based on it), add a note block after the TL;DR text and the issue
line. Only include it when there is actually a stack.

```markdown
> [!NOTE]
> 👈 #BASE_PR · 👇 **#THIS_PR** · 👉 _next not yet created_
```

Omit the 👈 segment if based on `main`. Omit the 👉 segment if
nothing depends on this PR yet. **When creating a PR based on
another PR**, update the parent PR's description to add or update
the 👉 segment pointing to the new child PR.

Neither line counts towards the TL;DR's 40 words.

## Through the Tool

`review_offer propose` and `review_offer edit` take the four
sections as fields: `problem`, `solution`, `validation` and
`tldr`, written in that order so the TL;DR is lifted from the
rest. The tool writes the headings, the order, and the place of
the stack note itself, so prefer the fields to a whole `body`.
For a stack, `propose-stack` takes one set of sections per
branch as `sections`.

An edit may name only the sections it changes and keeps the rest.
A description in the retired three-section shape has nothing to
keep, so give all four to replace it.

The limits in this skill are checked wherever a description is
written, and the tool refuses a description outside them whatever
the guard settings say. Only what can be counted or matched
exactly is checked: the sections, the word, sentence, bullet,
code-span and link limits, a TL;DR opening with "This PR" or using
bold, and Solution bullets labelled as artifacts. The refusal names
every section and rule it broke, so fix them all in one revision.
The tool also joins hard-wrapped paragraphs, so wrapping costs
nothing there.

Everything else in this skill is your judgement, and passing the
checks says nothing about it. A description can keep every limit
and still claim more than it shows, so ask the Before You Submit
questions before every submission, not only after a refusal.

## URI Indexing

Every URI in the description is a markdown reference link, never
a raw inline URL. Inline, write `[descriptive label][1]`; in a
footer block at the end of the body, write `[1]: https://...` on
its own line. Reuse a number for a repeated URI; keep the
sequence low and ordered. The label is descriptive prose, not
"here" or "this link". See `markdown-standard` for the full
reference-link convention.

## Worked Example

```markdown
### 💡 TL;DR

Three tools now succeed first time on calls that used to fail: merging by a short commit id, code lookups after the language server dies, and simultaneous cost queries. Each recovers once, so a lasting failure still shows.

### 🧩 Problem

The agent kept losing turns to failures it could not fix by calling again. Over September and October, merging a PR failed 23 times because the agent passed a short commit id and GitHub accepts only the full one. Code lookups failed on 11 of 93 calls with "Connection is closed." once the language server had died, and nothing restarted it. Cost queries crashed whenever two arrived together, because both tried to update the same database at once.

### 🔧 Solution

Each tool now recovers from its own failure instead of handing it back to the agent, and only once, so a failure that keeps happening still reaches you.

- Merge accepts a short commit id of at least seven characters as its safety check and sends GitHub the full id it matched. A shorter id is refused, because it guards too little.
- Code lookups start a fresh standalone language server when its connection is gone, then ask again. A server an editor owns is left alone, since restarting it would break the editor.
- Cost queries that arrive together share one update of the database, which also stops two of them racing to upgrade its schema.

The retry is one attempt rather than a loop, because a server that keeps dying should show as an error rather than hang the call.

### 🔬 Validation

Checked: each fix has a test that fails on the old code and passes now, and `pnpm lint`, `pnpm typecheck` and `pnpm test` pass. A short id is expanded before it reaches GitHub and a six-character one is refused; a dead server is replaced and retried exactly once, and an editor's server is never touched; three simultaneous cost queries answer from one update.

Not covered: the tests replace the language server and GitHub with stand-ins, so a real crash and a real merge are not exercised.

Watch: a "Connection is closed." error after this merges would mean the restart did not take.
```

The TL;DR opens with what changed and spends its second sentence
on the decision. The Problem starts from familiar tools and gives
counts. The Solution says how each fix works and why, and names
the one judgement call as a contrast. The Validation names its
checks, says where its checks stop, and gives the
signal to watch.

## Self-Review Comments

After creating the PR, propose inline self-review comments that
guide reviewers to areas that matter: design decisions worth
explaining, assumptions that need validation, scope boundaries,
deviations from the plan. Do not flag style or what the diff
already makes clear; no comments at all is fine.

The line range must contain exactly the code the comment is
about, scoped to the construct (a declaration, a conditional, a
function), and it must fall inside a diff hunk on the new side,
or the host rejects it. Check the ranges against the diff before
posting; do not guess them and do not retry with adjusted
numbers.

## After Creating

Every PR must have an assignee. `review_offer propose` takes
`assignees` when it opens the change, and `review_offer edit` sets
them afterwards. The backends name people differently (GitHub by
login, Meteorite by email), so `@me` is a `gh` convenience rather
than something to send through the tool. Through the CLI, run
`gh pr edit NUMBER --add-assignee @me` straight after
`gh pr create`.

## CLI Format

See `github-cli-convention` for command syntax: heredoc patterns,
`--body-file -` and metadata in separate commands.

## What Not to Do

- Don't add sections beyond the four, and don't change a heading:
  `### 💡 TL;DR`, `### 🧩 Problem`, `### 🔧 Solution`,
  `### 🔬 Validation`, exactly.
- Don't put anything above the TL;DR. The issue line and stack
  note go after its text.
- Don't hard-wrap body paragraphs; GitHub shows every line break
  in a PR body, so write each paragraph as one line.
- Don't list the files, docs or tests that changed.
- Don't leave Validation as "tests pass"; name what each check
  shows, and where the checks stop.
- Don't inline a raw URL; every link is a reference into the URI
  footer.
