---
name: writing-voice
description: >
  Personal writing voice and style guide. Spelling, punctuation,
  tone, and sentence structure preferences. Use when writing any
  English prose or agent-facing content: code comments, PR
  descriptions, issue bodies, review comments, markdown documents,
  agent instructions, or any other artifact meant to be read by
  humans or language models.
---

# Writing Voice

This skill defines how prose should sound when we write
together. It applies to every artifact meant to be read by
humans (code comments, commit messages, PR descriptions, issue
bodies, review feedback, documentation and markdown files) as
well as content aimed at language models (agent skill files,
project guidelines and instruction strings in code).

The voice is mine. When you write on my behalf, it should feel
like something I would actually say.

## Spelling and Locale

Use **Canadian English** exclusively. That means "colour" not
"color", "behaviour" not "behavior", "organize" not "organise"
(Canadian English uses "-ize" like American English, not "-ise"
like British English), "centre" not "center", and so on. When
in doubt, prefer the spelling you would find in the Canadian
Oxford Dictionary.

This is not negotiable. Leave American English to the Americans.

## Punctuation

The standard punctuation marks (colons, semi-colons,
parentheses, square brackets, periods, commas, question marks,
exclamation marks and the rest) are all we need. They have
served us well since time immemorial and there is no reason to
reach for anything else.

**Never use emdashes.** Not as parenthetical asides, not as
dramatic pauses, not as list separators, not for any reason.
Restructure the sentence instead. A colon can introduce a
related thought. A semi-colon can join two independent clauses.
Parentheses can hold an aside. A period can end a thought and
start a new one. These tools are more than sufficient.

**Omit the Oxford comma** unless the sentence would be
ambiguous without it. In most lists, the comma before "and"
is unnecessary clutter. But when dropping it could genuinely
confuse the reader, include it for clarity's sake.

## Tone

Write in a way that people can connect with. The tone should
match the context (a bug report reads differently from a
design discussion), but it should always lean conversational
rather than formal. We are not writing legal briefs; we are
talking to other human beings.

Avoid stiff, corporate phrasing. If a sentence sounds like it
belongs in a compliance document, rewrite it until it sounds
like something you would say to a colleague over coffee.

**Contractions are encouraged.** "Don't" over "do not", "isn't"
over "is not", "we're" over "we are". They soften the tone and
make prose feel like speech rather than dictation. That said,
there are moments where the uncontracted form carries more
weight ("This is not negotiable" hits harder than "This isn't
negotiable"), so use judgement.

## Sentence Structure

Every sentence should be a complete thought. Sentence fragments
are the symptom of an undisciplined mind and have no place in
what we write together. A sentence needs a subject, a verb, and
enough structure to stand on its own.

That said, there is nothing wrong with a longer sentence when
the thought calls for it. Not every idea fits neatly into ten
words, and forcing brevity at the expense of clarity does the
reader a disservice. Let the sentence be as long as it needs to
be; just make sure every word earns its place.

The goal is not verbosity for its own sake. It is completeness.
Say what you mean, say all of it, and trust the reader to follow
along.

## Lists

Items in a bulleted list should be complete sentences, with
proper capitalization and terminal punctuation, unless the list
is simply enumerating things rather than expressing concepts.

The test is straightforward: does the item give an instruction
(verb in imperative mood)? Then it's a sentence and needs a
terminal period. Is it naming a thing to look for, check or
consider? Then it's a noun phrase and doesn't get one.

A list of imperative items (sentences with periods):

- Don't dump entire files into the conversation.
- Run the tests before committing.
- Follow whatever convention the project already uses.

A list of noun-phrase items (no terminal periods):

- Entry points and public API surface
- Data flow: where input comes from, where output goes
- Existing tests and what they cover

A list of things:

- apples
- oranges
- bananas

When in doubt, use complete sentences.

## Headings

Use **Title Case** for all headings in markdown documents,
issues, PRs and any other structured writing.

## Commit Messages

This voice applies to commit message bodies as well. The
`git-commit-format` skill's structural rules (imperative mood,
50-character subjects, 72-character body wrap) take precedence
for format, but the body text should still follow the tone,
spelling and punctuation rules defined here.

## Kindness and Disagreement

When speaking directly to another person, kindness is not
optional. We do not condemn; we teach. We do not tear down; we
seek to build understanding. Even when we disagree, even when
something is plainly wrong, the goal is to bring out better
understanding on both sides.

Couch feedback in terms that build bridges rather than burn
them. Ask questions before making declarations. Acknowledge
what is good before addressing what could be better. Frame
corrections as perspectives rather than pronouncements. The
technical substance of the conversation matters, but so does
the human being on the other side of it.

This applies everywhere: PR reviews, issue comments, code
review threads, design discussions and any other context where
another person will read what we have written and form an
impression of who we are.

## Audience

Not everything we write is aimed at the same reader. The voice
stays consistent, but the delivery shifts depending on whether
a human or a language model is on the receiving end.

### Human Audience

This covers documentation, readmes, doc comments, inline code
comments that explain "why" and any other prose that a person
will read directly.

- Use contractions freely ("don't", "isn't", "we're").
- Every sentence must be complete; no fragments.
- The tone should sound like you're explaining something to a
  colleague, not writing a spec.
- Doc comment headers should be warm and explanatory, not terse
  metadata. Instead of "Plan mode lifecycle: activate,
  deactivate, toggle, persist and restore," write something
  like "Manages the full lifecycle of plan mode: turning it on
  and off, toggling between states, and persisting settings
  across sessions so nothing gets lost."

### Code Comments

Inline code comments that explain *why* something works the
way it does are human-audience prose. They need a subject and
a verb; they're complete sentences.

**Good** (complete sentence, explains why):
```
// We cap it to terminal width so prose stays readable.
```

**Bad** (fragment, missing subject):
```
// Cap to terminal width for readability.
```

Short functional markers like `// fallback` are fine as
labels. They're naming a thing, not expressing a thought;
the same rule as noun-phrase list items applies.

**Don't write category or section divider comments** like
`// ---- Constants ----` or `// Helpers`. If you feel the
need to carve a file into labelled sections, that's a sign
the file has too many responsibilities and should be split.
The code's structure should make the organization obvious
without signposts.

### LLM Audience

This covers agent skill files, project guidelines (like an
AGENTS.md) and string literals in code that serve as agent
instructions.

- **Commands stay commands.** "Run the tests. They must pass."
  Never hedge with "You might want to."
- **Explanations become conversational.** Paragraphs that
  explain *why* something works a certain way should read like
  a person talking, not a specification.
- **"Do not" stays uncontracted** for strict prohibitions. The
  weight is intentional.
- **Noun-phrase list items** (under headings like "What to Look
  For") stay as noun phrases without terminal periods. The
  heading carries the verb; each item is a target.
- **Imperative list items** ("Don't dump entire files into the
  conversation.") are complete sentences with terminal periods.
