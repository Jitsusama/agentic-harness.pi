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

Write for a teammate who knows the product but has not seen this
change, has two minutes, and will not open the diff. Almost every
line here is written by an agent, so the description is how a
person decides whether they are aligned with the change and trust
it. It is also the record somebody reads a year from now to learn
why the code is the way it is. If they have to read the code to
understand the description, the description has failed.

That reader asks four questions, in this order, and the four
sections answer them:

1. What is this? (TL;DR)
2. Why was it needed? (Problem)
3. What did you do, and why this way? (Solution)
4. Why should I believe it works, and what is still unproven?
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
need well under half of them, and a reader thanks you for every
word you leave out. A whole description that runs past about 350
words is usually saying something twice.

### 💡 TL;DR

The eight-second version: what is different once this merges,
and why that matters, in plain words. One or two sentences, at
most 40 words, which is what an adult reads in about eight
seconds. No code spans, no file names, no links, no bullets. It
must make sense to someone who reads nothing else, and it should
add to the title rather than repeat it. Write it last, once the
other three sections exist, and lift it from them.

### 🧩 Problem

Why the change exists. Start from something the reader already
knows (a tool, a workflow, a moment in their day), then say what
was wrong or missing, who it hurt and how we know: a count, an
incident, an error message somebody saw. Prose only, no bullets,
at most 120 words. It describes the world before this PR, never
the fix.

### 🔧 Solution

What the change does about the problem, as behaviour a person
would notice, not as files that changed. Open with a sentence
that answers the Problem directly. Then explain how it works at
the level a reader needs to trust it, and name the one decision
that mattered most with the alternative you turned down and why.
Say plainly if anybody has to do something or will notice a
difference: a breaking change, a new setting, a migration. At
most 200 words. Bullets are for three or more parallel behaviours
only, never more than five, and never a list of artifacts (no
"Docs:", "Tests:" or "Dependency:" entries: the diff already
shows those).

### 🔬 Validation

The evidence, written as claims about behaviour with the proof
beside each one: "a killed producer no longer hangs the run; a
new test reproduces the hang and fails on the old code". Then say
what is not proven: what was not run, what was only simulated,
what to watch after merge. Say only what you know: a limit is
something you did not do or could not test, never a guess about
what somebody else did. At most 100 words and five bullets. This is where code
spans, commands and short output excerpts belong, when they help.

## Writing for a Person

These are what make the four sections readable rather than merely
present.

- **Explain, then list.** A problem and its solution, told as
  cause and effect, is remembered far better than a list of
  facts about a topic. Bullets are fine for parallel items; they
  are not a substitute for saying why one thing leads to another.
- **Behaviour over artifacts.** Say what a person sees or can now
  do, not which module moved. Name an identifier only when the
  reader will type it or set it (a command, a config key), and
  put it in a code span.
- **Plain words.** Jargon and needless long words make readers
  trust a text less, even when every term is defined. Use the
  word the reader would use. Keep sentences under 40 words, and
  most of them well under.
- **Numbers that mean something.** "Merging failed 23 times in
  two months" tells the reader something; "1,353 tests pass"
  mostly tells them the suite is large. Count the thing the
  reader cares about.
- **Honest limits.** Saying what is unproven makes the rest more
  credible, not less. A Validation with no limits reads as one
  that did not look.
- **Nothing you cannot show.** Every claim has to come from the
  change, its commits or what you ran. A plausible detail you
  inferred is still invented, and one wrong detail costs the
  reader's trust in all the right ones.
- **The change as it stands.** Not the history of reaching it:
  leave out who found each fix, review rounds, earlier versions
  and commit mappings. When a PR grows, rewrite the description
  to fit the whole change.

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
the guard settings say. The refusal names every section and rule
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

Three harness tools now succeed on the first try where they used to fail on correct calls: merging with a short commit id, code lookups after the language server dies, and two cost queries at once.

### 🧩 Problem

The agent kept losing turns to failures it could not fix by calling again. Over September and October, merging a PR failed 23 times because the agent passed a short commit id and GitHub accepts only the full one. Code lookups failed on 11 of 93 calls with "Connection is closed." once the language server had died, and nothing restarted it. Cost queries crashed whenever two arrived together, because both tried to update the same database at once.

### 🔧 Solution

Each tool now recovers from its own failure instead of handing it back to the agent. Merge accepts a short commit id as its safety check, as long as it is at least seven characters, and sends GitHub the full id it matched; anything shorter is refused as too weak to guard anything. When the standalone language server's connection is gone, a lookup starts a fresh server and asks once more. A server that an editor owns is left to the editor. Cost queries that arrive together now share one update of the database, which also stops two of them racing to upgrade its schema.

The language server is retried once rather than in a loop, so a server that keeps dying still shows up as an error instead of hanging the call.

### 🔬 Validation

Each fix has a test that fails on the old code and passes now. A short id is expanded before it reaches GitHub, and a too-short one is refused. A dead server is replaced and retried exactly once, and an editor's server is never touched. Three simultaneous cost queries all answer from a single update. Lint, typecheck and the affected suites pass.

Not tried live: these are proven by tests against stand-ins, not by a real server crash or a real merge in a session.
```

The TL;DR says what a person gains in 33 words. The Problem starts
from something familiar and gives counts the reader can weigh. The
Solution answers the Problem, explains each fix as behaviour and
names the one judgment call. The Validation ties each claim to a
test and says what was not tried.

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
- Don't hard-wrap body paragraphs; write each as one line.
- Don't list the files, docs or tests that changed.
- Don't leave Validation as "tests pass"; say what each test
  proves, and what is still unproven.
- Don't inline a raw URL; every link is a reference into the URI
  footer.
