# compaction-selection-provider

Quotes the paragraphs a compaction drops whose exact words matter,
after the summary, so a standing instruction or a correction survives
in the words it was given in.

A summary paraphrases, and a paraphrase is where a rule set an hour ago
loses the word that made it a rule. In replays of real sessions,
excerpts appended beside the summary answered questions about the
earlier work better than the summary alone: 0.718 against 0.549 on a
one-point scale over 133 questions, at a budget of 3,000 tokens. Excerpts in place of the
summary did worse: wrong answers doubled. So this only ever adds to a
summary and never writes one.

## How It Works

- **Tagging.** After each turn, every message since the last compaction
  with a paragraph nothing is known of is split into paragraphs and
  each paragraph is asked which kinds it is: a standing instruction, a
  correction, a goal (from the user only), a decision, something still
  open, a failure, a finding, a change made, or something done. The
  tags are recorded on the session as a `compaction-selection-tags`
  custom entry. It runs in the background, four messages at a time and
  newest first, and never holds a turn up, so a backlog (a resumed
  session, or one whose host lost its tags) is tagged from the end the
  next compaction quotes most.
- **Checking.** When the compaction workflow starts writing a summary
  ahead, the tagger is first let catch up, so a backlog is tagged in
  time to be quoted. Then the paragraphs the compaction would quote
  are asked, against
  what the user said after them and the end of the conversation,
  whether they still hold. The answers are recorded as a
  `compaction-selection-holds` entry. This runs while the summary is
  written, so it costs no wait.
- **Quoting.** When the compaction applies, the tagged paragraphs
  before the verbatim tail the compaction workflow names (which can be
  earlier than pi's own cut, after a summary written ahead) are chosen
  within the budget: standing
  instructions and corrections first, most recent first, then the other
  kinds taking turns so no one kind crowds out the rest. A paragraph
  judged no longer to hold is left out; one never judged is quoted
  anyway. They are appended under `## Excerpts Kept Verbatim`, grouped
  by kind, with a note that the summary is right where the two
  disagree.

A paragraph is known by its words, through a hash of its text, and not
by the entry it sits in. Its tags and judgements are read back by that
hash, so they survive a host that rebuilds the session with new ids,
and a paragraph said more than once is tagged once and quoted once,
from its latest saying. Tool results, thinking and the harness's resume
messages are never tagged, and nor is anything from before the last
compaction when an old session is opened, so opening one does not tag
its whole history.

When the `session_recall` tool is active, each quote names its
paragraph, as `User (p:3f9a0c41de):`, and the note under the heading
says the reference reads it in place. Recall reads a reference back as
the latest entry saying that paragraph, so the model can go from an
excerpt to what was said around it.

## What It Records

Every compaction records what the selection did under
`details.contributions.selection`, whether it quoted anything or not:

- `label`, or `unavailable` with the reason, for the classifier, or
  `unresolved` when none was asked for yet this session;
- `store`, `budget` and `refs`;
- `candidates` before the tail, how many were `chosen`, and their
  `excerptTokens`;
- `notHolding`, judged no longer to hold, and `unchecked`, chosen
  without a judgement;
- `untagged`, messages the compaction dropped before they were tagged;
- `spend`, what tagging and judging cost since the last compaction;
- `taggingMs` and `judgingMs`, how long the classifier took over them,
  summed over its calls. Tagging runs a few calls at once and nothing
  waits on it, so this is the model's time beside what it cost, not
  anybody's wait;
- `nothingQuoted`, when it chose nothing, saying why:
  `nothing-dropped` (no dropped message had text to quote),
  `untagged` (none of the dropped messages had been tagged yet),
  `no-candidates` (they had been, and held nothing worth quoting),
  `none-holding` (every candidate was judged no longer to hold) or
  `over-budget` (none fitted the budget).

With the budget at 0 the record is
`{ budget: 0, nothingQuoted: "off" }`. Without a
classifier, and not because it was set to `off`, the person is told
once a session that the excerpts are off and why, since otherwise the
only sign is a summary with nothing after it.

`/compaction-status` says the same things ahead of time: the
classifier as last resolved, the budget, where tags are kept, whether
quotes name their paragraph, how many paragraphs are tagged and how
many messages wait to be, how many compactions on the branch quoted
excerpts, and what the last one's record says.

## The Classifier

Tagging and checking use one of pi's classifier models: a model that
reads JSON state and answers typed questions with probabilities,
rather than writing text. It is found among the classifier models
whose provider has credentials, and every call goes through pi's model
registry, so the owner's model config decides where it is served from.

By default it is the first of TypeSafe's Jev models in pi's catalog
that has credentials, which is the model the selection was tested
with: `typesafe/jev-latest`, then Jev through OpenRouter, OpenCode,
the Vercel AI Gateway and Cloudflare Workers AI. With none of them
configured, nothing is tagged or checked.

Each request puts the paragraphs asked about and some context in the
state, each paragraph with an id, and asks one yes-or-no question per
paragraph and kind. The answer read is the probability of yes.

## Cost

Each tagged message and each batch of twelve checks is one classifier
call. Its usage and how long it took (`ms`) are recorded on the entry
it produced, and the cost
ledger bills such an entry as a side call: the `side` kind, and a
cycle's `side_cost`.

## Where It Keeps Things

Tags and judgements are custom entries on the session by default. A
host that rebuilds sessions from a log of its own may drop custom
entries, and then every message would be tagged again on every turn.
`PI_COMPACTION_SELECTION_STORE=memory` keeps them in the process
instead, for as long as the session's process lives. What they cost is
then reported in the compaction's record (`spend`), and in the
`compacted` outcome event that carries it, but not billed by the cost
ledger, which reads only the session.

## Settings

- `PI_COMPACTION_CLASSIFIER=provider/model`: the classifier model, in
  place of Jev; `off` tags and checks nothing.
- `PI_COMPACTION_EXCERPT_TOKENS`: the excerpt budget, 3,000 by default;
  `0` turns the excerpts and the check off while tags still accumulate.
- `PI_COMPACTION_SELECTION_STORE=memory`: keep tags and judgements in
  the process rather than on the session.

## Why `-provider`

It contributes to the compaction workflow over `pi.events` without
importing it, through `SUMMARY_CONTRIBUTIONS`, the same seam a
compaction provider uses; it could live in another package.

## Files

- `index.ts`: registration and the session events.
- `classifier.ts`: resolving the classifier through the model registry,
  and the status the tagger and the record share.
- `store.ts`: the session store and the memory store.
- `tagger.ts`: tagging messages in the background.
- `contribution.ts`: the check ahead and the excerpts on apply.
- `status.ts`: the selection's section of `/compaction-status`.

The pure parts, from splitting paragraphs to rendering the excerpts,
live in `lib/compaction/selection/`.
