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
| Asking | [`ask/`](ask/) | Asking other models about a change, and keeping what their names mean stable |
| Drafts | [`draft/`](draft/) | State, plan compilation, persistence, rendering, publishing |
| Bus | [`events.ts`](events.ts) | How a provider in another package registers |

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
