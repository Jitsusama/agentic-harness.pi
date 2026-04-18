---
name: prose-standard
description: >
  Voice and style rules for all written output. Spelling
  (Canadian English), punctuation, tone and sentence structure.
  Use when writing or editing commit messages, PR descriptions,
  issue bodies, review comments, code comments, markdown, skill
  files, agent instructions or any other prose for humans or
  language models.
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

That includes getting the grammar right. Engaging, accessible
prose and grammatical correctness are not in tension; they
reinforce each other. Writing that is warm and conversational
but structurally unsound betrays an inability to communicate
properly, and that is not how I want to come across.

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

## Grammar and Sentence Structure

Proper grammar is not pedantry; it is how we present ourselves.
Every sentence we write reflects the care we bring to our work,
and sloppy grammar undermines that impression regardless of how
sound the underlying ideas might be. The goal is prose that
reads naturally and engages the reader while being structurally
impeccable.

Every sentence should be a complete thought. Sentence fragments
are the symptom of an undisciplined mind and have no place in
what we write together. A sentence needs a subject, a verb and
enough structure to stand on its own.

**Dangling and misplaced modifiers are not acceptable.** A
participial phrase must attach to the noun it modifies, and
that noun needs to actually be present in the sentence.
"Running the tests, several failures appeared" is wrong; the
failures weren't running the tests. "Running the tests, I
noticed several failures" is correct. When you spot a dangling
modifier, restructure the sentence so the subject is
unambiguous.

**Parallel structure matters.** When a sentence presents a list
or a comparison, every element should follow the same
grammatical form. "The system handles parsing, validation and
to generate reports" is broken. "The system handles parsing,
validation and report generation" is clean. Broken parallelism
reads like a stumble; the reader's brain expects a pattern and
trips when it doesn't hold.

**Subject-verb agreement is non-negotiable.** Collective nouns,
compound subjects and intervening phrases trip up even careful
writers. Read the sentence aloud; if the verb doesn't agree
with its subject, fix it.

These aren't exotic rules. They're the fundamentals that
separate prose which commands attention from prose that
distracts from its own message. Get them right every time.

That said, there is nothing wrong with a longer sentence when
the thought calls for it. Not every idea fits neatly into ten
words, and forcing brevity at the expense of clarity does the
reader a disservice. Let the sentence be as long as it needs to
be; just make sure every word earns its place.

The goal is not verbosity for its own sake. It is completeness.
Say what you mean, say all of it, and trust the reader to
follow along.

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
`commit-format` skill's structural rules (imperative mood,
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

This covers documentation, readmes, doc comments and any
other prose that a person will read directly.

- Use contractions freely ("don't", "isn't", "we're").
- Every sentence must be grammatically complete: proper
  subject-verb agreement, no dangling modifiers, no fragments.
- The tone should sound like you're explaining something to a
  colleague, not writing a spec.
- Doc comments follow the same conversational tone as other
  human-audience prose. The `code-style-standard` skill covers when and
  how to write them; this skill covers the voice they should
  use.

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
