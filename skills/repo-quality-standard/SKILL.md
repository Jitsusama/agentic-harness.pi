---
name: repo-quality-standard
description: >
  The quality standard every one of my repositories is held to
  as a whole: every folder with a reason, a name and a note
  saying what it holds, one gate, a short and true guide, every file
  linted at its strictest, programs in files of their own
  language, tests at the cheapest level that proves them and
  waiting on events, failures that say what was wrong, test
  code at the production bar, names, no dead
  code or half-migrations, and the sweep that keeps a
  repository there. Use when setting up or reviewing a
  repository, writing or checking its AGENTS.md, adding a
  linter, a check or a test level, adding, moving or naming a
  folder, deciding whether a sleep,
  a suppression, an embedded script or a long file may stay,
  or cleaning up after a wave of merges. Pairs with
  code-style-standard (how code reads), code-tdd-guide (how
  tests are written) and markdown-standard (how docs are laid
  out).
---

# Repository Quality Standard

This is what a repository of mine holds as a whole, beyond how
any one file reads. Code style, test method, markdown and prose
have their own skills, and this one points at them rather than
restating them. What it adds is the repository's side: what
every file is checked by, where things live, what a test may
and may not lean on, and how a repository stays clean as other
work lands in it.

Each rule says why, so it can be judged rather than obeyed, and
how it is held. A rule a check can hold is held by a check in
the repository's own gate; a rule no check can hold is held at
review. A rule a repository has no reason to follow is left
out of its bindings, with that reason, not kept for show.

## Bindings

Each repository's AGENTS.md states its bindings of these rules:
the command that is its gate, the linters and their settings,
where tests of each level live, and every exemption with its
reason. A rule that doesn't apply says so in one line. An agent
reads this skill for what the rules are and the repository's
AGENTS.md for how that repository holds them.

## 1. Every Folder Has a Reason, a Name and a Note

Every folder exists for one reason, is named for it, and says
what goes in it and what doesn't: a short README, or for a
folder of one kind of file, the opening comment of its entry
file. Nothing sits loose beside the folders that group its kind,
nothing has two homes, and nothing is named by accident (`misc`,
`new`, `old`, a date, a person). Things are grouped by what
they are for, and within that by kind, so a reader goes from the
repository's map to the file by names alone.

A code file past 800 lines, or a folder of more than 40 entries
with no grouping, has its reason written beside it (a parser's
table, generated data) or is split. Tests mirror the tree they
prove, and tools that aren't tests don't live among them.

Why: in Joel's words, "nothing should look like a mess on a
thirteen year old's floor". A reader finds a thing from its name
only while every folder says what it holds and stays small
enough to scan; a loose file or a doubled home makes every later
reader search, and a long file is usually several things that
grew together.

Held by: a check that every folder carries its README or entry
comment, and one listing files and folders past the limits with
no reason beside them.

## 2. One Gate per Repository

One local command runs every check the repository has:
`nix flake check` in a Nix repository, one package script such
as `pnpm check` in a TypeScript one. The `verify` tool runs it.
Nothing waits on hosted CI, and no hosted CI is added.

Why: proof runs where the work is, on the machine it is for. A
check that nothing runs holds nothing, and a repository whose
checks live in a hosted pipeline nobody watches ends with
checks that rot unnoticed.

Held by: the binding naming the command, and every other rule's
check being part of it.

## 3. A Guide That Is Short and True

AGENTS.md is a map, not a manual: what the repository is, where
each kind of thing lives (nested guides included), its rules
in a line each with a link to their reasons, its commands, and
its bindings. Depth lives in docs and skills it links to.
CLAUDE.md, where one exists, is `@AGENTS.md` and nothing else.

Every path, file and command a guide or doc names exists. One
fact has one home; a second place that needs it links to the
first.

A change updates, in the same change, every doc, README and
agent direction it makes stale: a moved file's mentions, a
renamed command, a rule it changes, a guide's map when it adds
a folder. Its description says which it updated, or that none
needed it.

Why: an agent reads AGENTS.md on every session, so every stale
line costs every session, and a guide naming something removed
sends work the wrong way. A fact kept in two places drifts. A
doc left for later is left for good, since the next reader
can't tell it went stale.

Held by: a check that every path and command named in the
repository's markdown resolves, and at review for what a check
can't see, such as a rule's wording.

## 4. Every File Is Linted at Its Strictest

Every language in the repository has a linter and, where one
exists, a type checker, run at its strictest preset: ruff with
every rule and mypy strict, clippy with pedantic, biome's full
set, shellcheck with its optional checks, TypeScript strict
with unchecked index access refused. Each rule turned off has
its reason beside it, in the config or at the line. Test code
is held exactly as other code is.

Why: a strict linter catches in a second what review catches
in an hour, or doesn't. A rule turned off without a reason
can't be judged later, and a file no linter reads is where
every slip gathers.

Held by: the gate failing on any tracked file no linter reads.
Generated files and data are listed as such.

## 5. Programs Live in Files of Their Own Language

No program longer than five lines is written as a string inside
another language: no shell in Nix, no SQL, page JavaScript or
GraphQL in TypeScript, no QML or Python in Nix. It lives in a
file of its own language, read in or built into the string, so
its linter and its editor read it.

Why: a program in a string is read by no linter, type checker
or editor, and the values spliced into it are where quoting
breaks.

Held by: a check scanning for embedded programs past five
lines. A short splice of values (a wrapper calling a program
with paths) may stay.

## 6. Each Test at the Cheapest Level That Proves It

A behaviour is proven by the cheapest test that can show it:
a function by a unit test, a view's logic by an offscreen or
headless check, the whole machine only by a VM or browser test.
A VM or browser test proves each path through the system once,
and the cases of that path live at the cheaper level. Where the
test runs (locally, in a VM, in a container) doesn't matter;
confidence for the time spent does.

Why: an expensive test that enumerates cases makes every change
pay for all of them, and a failure in it says less about where
the fault is.

Held by: review, with the gate's timing record showing where
the time goes.

## 7. Tests Wait on Events

A test waits on the thing it needs: a report, a journal line, a
file, a unit's state, an event stream. A fixed sleep stands
only for "nothing happens for this long", and says so in a
comment. A test that can't run, for want of a browser, a device
or a tool, fails the gate instead of skipping quietly.

Why: a sleep standing for an event is too long when the machine
is idle and too short when it's busy, so it's both slow and
flaky. A silent skip passes a gate that proved nothing.

Held by: a lint over test code that refuses a sleep without its
comment, and the gate refusing skips.

## 8. A Failing Assertion Says What Was Wrong

Where the framework can't show what each side held, the
assertion carries a message saying what was expected: Rust's
bare `assert!`, Python's asserts that aren't comparisons, a
shell check's `fail`. Where it can (pytest's rewritten
comparisons, vitest's matchers, Rust's `assert_eq!`), no
message is added.

Why: a failure that says only "assertion failed" makes the
reader rerun the test to learn anything, and a message that
repeats what the framework shows is noise.

Held by: review, and a lint where the language has one.

## 9. Test Code at the Production Bar

Test helpers, fakes and fixtures live once, in the repository's
test library, not copied into each file. Every suppression in
test code carries its reason. code-style-standard's testing
rules apply in full.

Why: a helper copied into forty files is forty helpers that
drift, and a test nobody can read is a test nobody trusts.

Held by: the linters (rule 4) and review.

## 10. Names Say What a Thing Is

A file, folder or function is named for what it is or does,
never `helpers`, `utils`, `shared`, `common` or `misc`. One
folder name means one thing in the repository. One thing has
one word, across code, docs and what a program says; where a
glossary exists for the machine, its words are the ones used.

Why: a vague name sends every reader into the file to learn
what it holds, and two words for one thing read as two things.

Held by: review, and the glossary's own checks where it has
them.

## 11. No Dead Code, No Half-Migrations

No file nothing reaches, no export nothing imports, no one-shot
script whose work is done. A pattern being replaced is finished
in the same piece of work, or tracked with an owner and the
place it will be finished; two ways of doing one thing don't
stay side by side by accident.

Why: dead code is read, searched and maintained as if it were
alive, and a half-migration doubles what every reader has to
learn.

Held by: deadnix, the compilers' unused warnings and knip for
TypeScript, and the sweep (below) for half-migrations.

## Staying There

After each wave of merges, a sweep reads what landed against
these rules: stale paths, files no linter reads, new embedded
programs, sleeps, copied helpers, debris left by work that
moved on. It runs each repository's checks, then reads its
AGENTS.md and its nested guides against the tree as it now
stands, since a guide can be true in every path and still
describe a repository that moved on. It fixes what is its own, and sends the rest to the
owner of that part of the repository. The checks above keep
most of it from landing at all; the sweep catches what no check
can.

An exemption is never silent. It carries its reason where it
is made, and the binding lists it, so the next reader can judge
whether the reason still holds.
