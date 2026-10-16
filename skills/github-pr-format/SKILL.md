---
name: github-pr-format
description: >
  PR description structure and narrative, written for a person
  who will not read the code. The closed four-section body
  (TL;DR, Problem, Solution, Validation), what each section
  must do and how long it may be, URI indexing, self-review
  guidance and title conventions. Use when writing or editing a
  pull request description. Pairs with github-cli-convention
  for command syntax and markdown-standard for markdown
  structure. Follow the user's writing voice and prose style
  guides for description text.
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

### 💡 TL;DR

The eight-second version, at most 40 words in one or two
sentences. The first sentence is a headline that stands on its
own: it opens with the thing that changed (never "This PR" or
"This change") and says what is different once this merges and
for whom. The second sentence, if there is one, carries what the
reader most needs next: the key decision, or a limit that changes
how far the first sentence can be trusted. If the checks cover
less than the headline claims, the TL;DR says how far they reach;
a limit goes there only when it narrows the headline. No code spans, file
names, links, bullets or bold. Write it last and lift it from the
other three sections.

### 🧩 Problem

Why the change exists, as what is wrong or missing compared with
what the reader already knows: what failed, for whom, and how we
know (a count, an incident, an error somebody saw). Do not tour
the subsystem; the reader knows it. If the reader would likely
assume the wrong cause, or the change reverses something they
rely on, say so outright: "it looks like X; it is actually Y,
because Z". Prose only, at most 120 words. It describes the world
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
because a server that keeps dying should show as an error"). Do
not invent an alternative where there was no real choice.

Then say what anybody will notice or has to do: a breaking change,
a new or changed setting or default, a dependency, a migration.
These are never the part you cut.

Bullets are for parallel behaviours only, at most five, one
behaviour each, opening with the words that tell them apart (not
a column of "Adds..."). Never a list of artifacts: no "Docs:",
"Tests:" or "Dependency:" entries. If the change has more
independent parts than five bullets can hold, name the rest in one
"Also:" sentence; a change that cannot be described this way
should probably be split. At most 200 words.

### 🔬 Validation

Three short moves, in this order:

1. **Checked:** each claim about behaviour with the check that
   shows it, named: a test, a command, a CI job, an environment,
   and what it would have caught ("a new test reproduces the hang
   and fails on the old code"). State results flatly. A bare
   "tests pass" says only that nothing the suite covers broke.
2. **Not covered:** where the checks above stop, stated as a fact
   about the checks rather than a claim about yourself: what a
   stand-in replaces, which case no test reaches, and what that
   leaves open ("the tests replace the server with a stand-in, so
   a real crash is not exercised"). Read it off the tests and the
   commands that ran. Say you did not run something only when you
   know you did not; never guess, and never add a limit to look
   careful. If the checks reach everything the Solution claims,
   leave this move out.
3. **Watch** (only when there is something to watch): the signal
   after merge that would show the change is wrong.

Give counts with their denominator ("12 of 14 call sites") and
before-and-after values rather than percentages alone. No hedges
("should work", "likely", "seems") and no assurances
("thoroughly tested", "robust"). At most 100 words and five bullets. Code spans, commands and short output excerpts belong
here when they help.

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
  use. Keep sentences under 40 words, most well under.
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
the guard settings say. So are the mechanical parts of the wording:
a bare all, every or most in the TL;DR, a TL;DR opening with "This
PR", a Solution with no reason in its prose, list items that open
alike, hedges, assurances or a bare "tests pass" in Validation, and
pointers at the session or selling words anywhere. The tool also
joins hard-wrapped paragraphs, so wrapping costs nothing there. The refusal names every section and rule
it broke, so fix them all in one revision.

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

Checked: each fix has a test that fails on the old code and passes now. A short id is expanded before it reaches GitHub and a six-character one is refused; a dead server is replaced and retried exactly once, and an editor's server is never touched; three simultaneous cost queries answer from one update.

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
