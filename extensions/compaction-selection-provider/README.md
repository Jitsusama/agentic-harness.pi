# compaction-selection-provider

Quotes the paragraphs a compaction drops whose exact words matter,
after the summary, so a standing instruction or a correction survives
in the words it was given in.

A summary paraphrases, and a paraphrase is where a rule set an hour ago
loses the word that made it a rule. In replays of real sessions,
excerpts appended beside the summary answered questions about the
earlier work better than the summary alone, by about 0.15 on a
one-point scale at a budget of 3,000 tokens. Excerpts in place of the
summary did worse: wrong answers doubled. So this only ever adds to a
summary and never writes one.

## How It Works

- **Tagging.** After each turn, every message since the last compaction
  that has no tags yet is split into paragraphs and each paragraph is
  asked which kinds it is: a standing instruction, a correction, a goal
  (from the user only), a decision, something still open, a failure, a
  finding, a change made, or something done. The tags are recorded on
  the session as a `compaction-selection-tags` custom entry. It runs in
  the background, one message at a time, and never holds a turn up.
- **Checking.** When the compaction workflow starts writing a summary
  ahead, the paragraphs the compaction would quote are asked, against
  what the user said after them and the end of the conversation,
  whether they still hold. The answers are recorded as a
  `compaction-selection-holds` entry. This runs while the summary is
  written, so it costs no wait.
- **Quoting.** When the compaction applies, the tagged paragraphs
  before the verbatim tail are chosen within the budget: standing
  instructions and corrections first, most recent first, then the other
  kinds taking turns so no one kind crowds out the rest. A paragraph
  judged no longer to hold is left out; one never judged is quoted
  anyway. They are appended under `## Excerpts Kept Verbatim`, grouped
  by kind, with a note that the summary is right where the two
  disagree.

A paragraph said more than once is quoted once, from its latest saying.
Tool results, thinking and the harness's resume messages are never
tagged, and nor is anything from before the last compaction when an
old session is opened, so opening one does not tag its whole history.

## The Classifier

`PI_COMPACTION_CLASSIFIER=provider/model` names a model in pi's model
config, and nothing runs until it does. Every call goes through pi's
model registry, so whatever the config puts behind that name answers:
a small general model, or a provider serving a model built for
classification.

The request is `lib/classifier/`'s contract: one user message holding
a `classification/v1` JSON request (the units, some context, and a
yes-or-no question per unit and kind), and one `answer` tool the model
calls with the probability that each answer is yes. A provider serving
a dedicated classifier reads the request back with
`requestFromContext` and answers with that tool call.

## Cost

Each tagged message and each batch of twelve checks is one classifier
call. Its usage is recorded on the entry it produced, and the cost
ledger bills such an entry as a side call: the `side` kind, and a
cycle's `side_cost`.

## Settings

- `PI_COMPACTION_CLASSIFIER=provider/model`: the classifier; unset,
  nothing is tagged or checked.
- `PI_COMPACTION_EXCERPT_TOKENS`: the excerpt budget, 3,000 by default;
  `0` turns the excerpts and the check off while tags still accumulate.

## Why `-provider`

It contributes to the compaction workflow over `pi.events` without
importing it, through `SUMMARY_CONTRIBUTIONS`, the same seam a
compaction provider uses; it could live in another package.

## Files

- `index.ts`: registration and the session events.
- `classifier.ts`: resolving the classifier through the model registry.
- `tagger.ts`: tagging messages in the background.
- `contribution.ts`: the check ahead and the excerpts on apply.

The pure parts, from splitting paragraphs to rendering the excerpts,
live in `lib/compaction/selection/`.
