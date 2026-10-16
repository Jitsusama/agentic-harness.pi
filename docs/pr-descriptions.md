# How the PR Description Format Was Chosen

The `github-pr-format` skill and the shape `review_offer` holds a
description to came out of a study run in October 2026. This is what
it measured, what it found and where its evidence stops, so a reader
can weigh the format without the study's working files.

## The Problem It Started From

The 40 most recent merged descriptions in this repository (#516 to
#555) had a median of about 450 words and a maximum of 792. About
half the words were Resolution bullets listing files, one carried 26
code spans, and the first sentence was usually 20 to 35 words of
background. None said where its checks stopped. All of them passed
the section gate of the day, which checked only that the headings
existed.

## Why Four Sections

The order is TL;DR, Problem, Solution, Validation, and nothing else.

- **TL;DR first:** a bottom-line-up-front summary, which peers asked
  for and which the research on advance organisers and layered
  notices supports: most readers stop after the first lines, so
  those lines have to carry the change on their own.
- **Problem before Solution:** readers recall text organised as a
  problem and its solution better than the same facts as a loose
  list, and a reader judges a fix against the problem they were
  just told about.
- **Validation last, with where the checks stop:** a reader trusts a
  claim more when it comes with its limit, and the limit a reader
  needs is the one about the checks, not about the author.

The research behind each point, with the papers, is in the quest's
research reports; the ones that bear on a rule are cited in the
skill itself.

## The Ceilings

Each section has a word ceiling: 40 for the TL;DR (in two
sentences), 120 for the Problem, 200 for the Solution and 100 for
Validation, and no sentence over 40 words. They replaced ceilings of
180, 300 and 180, because writers fill the room they are given.
Ceilings that scaled with the size of the change were tried and
turned down: they cut 42 words a description but readers understood
the fixed version better when shown both.

## What Was Measured

Descriptions were written by an agent following each version of the
skill, from the same commits and diff the original author had, and
compared with the originals.

- **Model readers** saw a description for a glance, a skim or a full
  read, then answered questions graded against an answer key built
  from the change itself.
- **A fact check** marked every claim as supported, unsupported or
  wrong, and tagged invented limits and overgeneralisations.
- **Auditors** (Claude Opus 5.5 and GPT-5.5, and Gemini in one
  round) graded each description on ten criteria: a standalone
  headline, a TL;DR the Solution backs, the problem, the mechanism,
  the key decision, what a reader must act on, validation, accuracy,
  no noise, and whether they would trust it.

Analysis used a paired bootstrap (10,000 resamples) and a sign-flip
permutation test (20,000), with a fixed seed.

## What It Found

On 20 held-out PRs that no version of the skill was tuned on, the
version shipped in core 0.9.0 against the original descriptions:

| Measure | Originals | Shipped skill |
|---|---|---|
| Glance questions right (of 2) | 0.44 | 1.50 |
| Skim questions right | 4.31 | 5.29 |
| Full read right (of 12) | 9.38 | 9.96 |
| Limits a reader could name | 1.15 | 1.69 |

The shipped version was chosen over a longer one that scored 0.45
higher on a full read, because the longer one invented nearly twice
as many limits (1.15 against 0.65 a description, p = 0.029): accuracy
was preferred to completeness.

A second round removed every refusal based on a word list (unscoped
"all" and "most", hedges, selling words and five more). Checked by
hand over 76 descriptions and the research reports, the scope rule
was right about 3 times in 45, and the repeated-opener rule never.
Removing them cost nothing measurable: the audit score moved from
7.35 to 7.58 and invented limits from 0.81 to 0.44 a description,
neither significant on 16 PRs. The checks that remain count or match
exactly, and the judgement moved into the skill's Before You Submit
questions.

A third round iterated on the skill itself against the auditors'
reasons on 16 development PRs, then froze it and ran it once on the
same 20 held-out PRs. The rules it added: name the case where a
claimed behaviour does not hold, name every check as the reader
would rerun it, keep each qualifier when a claim moves into the
TL;DR, name what the reader must act on as they will type it, and
add no fact the change does not show. Two ideas were tried and
dropped: demanding every decision's cost made writers invent costs,
and a pass that checked the draft and then amended it added new
unsupported claims.

On the held-out PRs, criteria passed of ten, averaged over Opus
and GPT:

| Writer | Original | Previous skill | This skill |
|---|---|---|---|
| Knows what the author knew | 5.95 | | 9.38 |
| Sees only the diff | | 8.13 | 9.13 |

This skill beat the originals on all 20 PRs and the previous skill
on 15 of 20, with 2 worse (p = 0.0004), and cut the claims the
auditors marked inaccurate from 0.85 to 0.33 a description. Opus,
the stricter auditor, rated excellent 7 of the 20 written with the
author's knowledge and 9 of the 20 written from the diff alone, so most still
have a point a careful reviewer would fix, usually a detail of the
code misread rather than a rule broken.

## Where the Evidence Stops

- The readers and auditors are models, not people. The auditors
  disagree with each other often, and a model reader is not a busy
  engineer deciding whether to merge.
- One repository, about 36 PRs in all, so only large effects show.
- The answer keys and the fact check were built partly from the
  original descriptions, which favours them.
- No person has yet read a blind pair of descriptions and said which
  told them more.
