# Review

One substrate for the activity of reviewing code changes,
whatever hosts them and whether anything hosts them at all.
GitHub, Meteorite, GitLab and a bare git repo are providers
behind one neutral model.

The vocabulary is git's wherever git has a word for the thing.
A diff has an old side and a new side, not a left and a right.
An anchor names the commit it was formed against. A stack is
refs pointing at refs. Forge inventions stay inside the
providers that invented them.

## The Two Ideas

**A review targets a change, not a proposal.** A
[`ReviewTarget`](change.ts) is a hosted proposal, a range of
commits, or an ordered set of refs. Reviewing a stack of
branches nobody has proposed is therefore a first-class
activity rather than a degenerate case, and so is reviewing
your own stack before deciding whether to post it.

**Composing is separate from publishing.** A
[`ReviewDraft`](draft/handle.ts) accumulates everything a
review session produces: anchored findings, replies into
threads other people started, resolutions, reactions and a
verdict. No backend accepts that mixture as one operation, so
the mixture is held here and compiled later.

## Layers

| Layer | Files | What it is |
|---|---|---|
| Model | [`change.ts`](change.ts), [`anchor.ts`](anchor.ts), [`diff.ts`](diff.ts), [`conversation.ts`](conversation.ts), [`stack.ts`](stack.ts), [`checks.ts`](checks.ts) | The neutral vocabulary, plus diff parsing and anchor checking |
| Contract | [`provider.ts`](provider.ts), [`capabilities.ts`](capabilities.ts) | Facets a provider implements, and how far each one goes |
| Selection | [`register.ts`](register.ts), [`resolve.ts`](resolve.ts), [`bind.ts`](bind.ts), [`config.ts`](config.ts) | Which provider handles this, decided in a declared order |
| Findings | [`finding.ts`](finding.ts) | Observations about a change, numbered and stored, outliving whatever raised them |
| Asking | [`ask/`](ask/) | Putting a change to other models: who is asked, what they are told, what comes back, and what it is recorded as |
| Drafts | [`draft/`](draft/) | State, plan compilation, persistence, rendering, publishing |
| Bus | [`events.ts`](events.ts) | How a provider in another package registers |

## Asking Is Nine Small Things, Not One Big One

[`ask/`](ask/) holds the rounds a review can run. Each file answers
one question, which is what keeps any of it testable without a model
in the loop:

| File | What it decides |
|---|---|
| [`roster.ts`](ask/roster.ts) | Who gets asked, out of untrusted config |
| [`identity.ts`](ask/identity.ts) | What a participant id is allowed to mean |
| [`anchorable.ts`](ask/anchorable.ts) | Where a finding may point |
| [`prompt.ts`](ask/prompt.ts) | What a participant is told |
| [`wire.ts`](ask/wire.ts) | Where the JSON is in what a model said |
| [`harvest.ts`](ask/harvest.ts) | What its answer amounts to |
| [`council.ts`](ask/council.ts) | Asking everybody at once |
| [`judge.ts`](ask/judge.ts) | Consolidating what they said |
| [`critique.ts`](ask/critique.ts) | Pushing back on what was consolidated |
| [`audit.ts`](ask/audit.ts) | Whether the change answers what people asked for |
| [`span.ts`](ask/span.ts) | Which changes a finding is about |
| [`stack-round.ts`](ask/stack-round.ts) | Asking about a whole stack at once |
| [`run.ts`](ask/run.ts) | What a round was, as a record |
| [`store.ts`](ask/store.ts) | Finding a round somebody else ran |

The seam that makes it testable is [`CouncilDeps`](ask/council.ts):
asking, recording and the clock. Everything else is a pure function of
what came back, so the whole pipeline can be driven from a script of
fake answers.

**One bad entry costs one finding, not the batch.** A round is
expensive to run, so nine findings survive the tenth being malformed,
and every drop leaves a warning naming the index and the reason. The
principle is graded: a bad label or a missing location drops the
finding, since guessing either puts words in a reviewer's mouth, while
a bad severity drops only itself, because the severity is a decoration
and the observation is the value.

**Findings are recorded in roster order even though participants are
asked at once.** People say finding numbers out loud, and a number
that depended on which model was quickest would make the same round
describe itself differently every time.

**Nothing one participant does takes a round down.** A failure the
runner reports and an exception it throws are the same event seen from
two sides, and both are recorded against that participant so the rest
of the round survives.

**A critique records positions, not findings.** A critic that could
also raise findings would make the round both a discovery pass and a
challenge to one, and afterwards neither could be read alone. Silence
about a finding is no position and never assent: reading an absent
critique as agreement would manufacture consensus out of a critic that
ran out of budget, making a weakly supported finding look
corroborated.

## A Roster Is Read From Config, Not From a Call

[`ask/roster.ts`](ask/roster.ts) turns whatever was in a config
file into participants, or says precisely what was wrong with it.
Every refusal names the path it found the trouble at, because a
sentence saying a roster is invalid is true and useless when the
roster has six reviewers, and a config error found at fan-out time
has already cost the caller a wait.

A participant with a persona and no id takes the persona's name,
since naming a reviewer twice to say one thing is noise. An
explicit id wins, which is how the same persona runs twice at two
mechanism settings.

Duplicate ids are checked **after** persona naming rather than
before. One entry named by its persona and one named explicitly can
collide in a way that is invisible in the file, so validating the
input shape would miss exactly the case a human cannot see.

## An Id Keeps Meaning One Thing

A finding's origin names the participant that raised it, and a
reader trusts that name to identify one thing. Re-point an id at
a different model halfway through a session and every origin
recorded before the change quietly starts lying, with nothing on
the record to say so.

So [`ask/identity.ts`](ask/identity.ts) holds an id to what it
meant, once findings are attributed to it. Two details are worth
knowing:

It is told the findings rather than going to look for them.
Whether a finding is attributed to an id is a fact about the
finding, so a module that had to know where findings are stored
would be answerable to every future place they might live.

An id nothing points at is re-pointed in silence. The trail only
matters where there is output to attribute, and refusing
otherwise would make fixing a roster typo a chore. When it does
refuse, it names both ways out: use another id, which keeps the
trail exact, or release this one and accept that its findings
become ambiguous about which participant they came from.

## Facets, Not One Interface

A single provider interface would make every backend pretend.
A bare git repo has topology and diffs and no conversation
anywhere; a forge has all of it. So a provider implements what
it has:

- `proposals`: read a change, its diff, its checks; fetch it
  into a local repo as a ref.
- `stacking`: read stack topology, marked `authoritative` when
  the backend recorded the parentage and `derived` when it was
  inferred.
- `conversation`: reviews, threads, messages; post a review,
  reply, resolve, comment, react.
- `authoring`: propose, edit, merge, close. Typed now,
  implemented later, so the reviewing half cannot be designed
  into a shape authoring will not fit through.

[`Capabilities`](capabilities.ts) sit under the facets, because
a facet is too coarse to publish against. Two providers both
post reviews, but one caps a batch at a hundred comments, one
cannot thread a reply onto a top-level message, and one has no
way to unresolve.

## Resolution Order

The failure this replaces is a tool quietly reaching for the
wrong backend, so nothing defaults:

1. A repo mapping in config, whose providers are tried in the
   order given. Unregistered ids are skipped, which makes a
   mapping safe to write before the provider ships.
2. Every registered provider, in claim priority order.
3. The user's own reference shapes, which teach the substrate a
   URL or short form no provider recognizes.
4. A refusal naming the knob that would fix it.

The answer is then bound to the target, so a provider
registering mid-session cannot change what an open draft is
about to post to.

## Publishing Is Planned First

[`compilePlan`](draft/plan.ts) reads the draft against the
provider's capabilities and returns what will happen: the
operations that will run, the items that will land somewhere
other than where they were aimed, and the items that cannot
land at all. Nothing there touches a network, so the whole
story can be shown to a person first. Degradation announced up
front is a decision; degradation discovered from a rejected
request is a surprise.

[`publishPlan`](draft/publish.ts) then runs it, reporting each
operation separately and continuing past a failure, because a
posted review with one failed reply is not a failure to
publish. The handle keeps exactly what did not land, so a retry
sends the remainder.

Where a target has no host, [`renderDraft`](draft/render.ts)
writes the review out as a document instead, with the verdict
as a git trailer.
