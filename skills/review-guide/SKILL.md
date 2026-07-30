---
name: review-guide
description: >
  How to put up, read and review a change through the
  `review`, `review_see`, `review_say`, `review_ask`,
  `review_draft` and `review_offer` tools, whatever system
  hosts it: GitHub,
  Meteorite, a GitLab merge request, or a range of commits
  nobody has proposed at all. Covers attaching the change
  you are working on, reading a diff and a conversation,
  judging a stack by its provenance, asking other models
  through a council and a judge, composing a review as a
  draft, planning what publishing will do, proposing a
  branch as a change and moving it to merge, and reporting
  degradation honestly.
  Use when asked to "review
  this change", "read this PR", "what did people say about
  it", "reply to that thread", "resolve those comments",
  "approve it", "review these commits", "run a council",
  "get several models to review this", "have a judge
  consolidate that", "open a PR", "put this up for review",
  "mark it ready", "ask someone to review it", "merge it",
  or any request to look at, comment on or land a change.
  Pairs with
  code-review-standard for what to evaluate, comment-format
  for how a remark reads, and prose-standard for voice.
---

# Review Guide

Six tools cover the whole arc, from a branch to a merge. They
speak one vocabulary
regardless of what hosts the change, so the same phrasing
works on a GitHub pull request, a Meteorite change and a
stack of local branches.

They are split by what you are trying to do, not by what you
are doing it to. The subject is nearly always the change, so
splitting by subject would only ask you to guess which tool
owned which question.

| Tool | For |
|---|---|
| `review` | What you are working on: attach, detach, next, prev, capabilities |
| `review_see` | Everything reading tells you: change, diff, checks, stack, changes, threads, reviews, messages, findings |
| `review_say` | Saying something now: reply, comment, resolve, unresolve, react |
| `review_ask` | Putting the change to other models: council, judge, critique, audit, stack, runs, retry, release |
| `review_offer` | Putting work up and moving it along: propose, edit, ready, draft, reviewers, close, reopen, merge |
| `review_draft` | Composing a whole review, then planning and publishing it |

## What You Want, and What to Call

Start here. Find the row, make the call.

| You want to | Call |
|---|---|
| Work on a change and stop naming it | `review attach change:...` |
| Know what this change is | `review_see change` |
| Read the diff | `review_see diff` |
| Know if CI is happy | `review_see checks` |
| See what it sits on | `review_see stack` |
| Read what people said | `review_see threads` |
| Answer one remark | `review_say reply thread:N` |
| Close a thread out | `review_say resolve thread:N` |
| Say one thing on the change | `review_say comment` |
| Get several models to review it | `review_ask council` |
| Boil their findings down to one list | `review_ask judge` |
| Have them argue with that list | `review_ask critique` |
| Know which inbound threads are already fixed | `review_ask audit` |
| Review a whole stack together | `review_ask stack` |
| See what a round raised | `review_see findings` |
| Keep a finding, in your own words | `review_draft decide settle:promote` |
| Drop a finding | `review_draft decide settle:dismiss` |
| Keep a finding as work, not a remark | `review_draft decide settle:fix` |
| Get the next thing to fix | `review_draft fix-next` |
| Record a fix that landed | `review_draft fix-done commit:...` |
| Drop a queued fix | `review_draft fix-skip body:"why"` |
| See the fix queue | `review_draft fixes` |
| Add a remark of your own | `review_draft finding path:... line:N` |
| Know what publishing will do | `review_draft plan` |
| Send the review | `review_draft publish` |
| Send a review to every change in the stack | `review_draft publish-stack` |
| Write it up when nothing hosts it | `review_draft render` |
| Put a branch up for review | `review_offer propose draft:false` |
| Fix a title or description | `review_offer edit` |
| Move it out of draft | `review_offer ready` |
| Ask people to look | `review_offer reviewers` |
| Land it | `review_offer merge expectedHead:...` |

## Three Ways This Gets Used

**Reviewing someone else's change.** Attach it, read the diff and the
checks, run a council and a judge, decide each finding into a draft,
plan, publish. The audit round is worth a call first when the change
already has threads on it: it tells you which of them the change now
answers, so you are not re-raising something somebody already fixed.

**Reviewing your own before you ship.** The same council, but nothing
gets published. Read the findings, fix what is real, and never post: a
review of your own change posted to your own change is noise. This is
the flow with the highest value per token, because the findings go
straight into the code.

**Answering reviews on your own change.** Read the threads, audit them
against what the change now does, then reply thread by thread with
`review_say`. Keep the audit advisory. It tells you where to look; it
does not write the reply, because how you talk to somebody who took
the time to review your work is not a thing to automate.

## When Not to Reach for This

A one-line diff does not need a council. Six models reading a typo fix
costs real money and produces six ways of saying it is fine. Read it
yourself.

A change you already understand does not need a judge. The rounds earn
their cost on changes that are large, unfamiliar, or in code where
being wrong is expensive.

And nothing here replaces reading the code. A council that finds
nothing is not a change with nothing wrong with it.

## One Question Per Tool, Which Settles Where Deciding Lives

The division that stops these overlapping:

- `review_ask` **produces** findings
- `review_see findings` **reads** them, because reading is a read
  wherever the thing came from
- `review_draft decide` **curates** them into the review

So `review_draft` is the single place where what you will say gets
settled, whether a remark came from a model or you wrote it yourself.
A council does not post, and a draft does not run models.

## Asking Other Models

Three rounds, in order, each refusing to run ahead of the one before:

- `review_ask council` asks every reviewer on the configured roster,
  independently and at once. This is the discovery pass.
- `review_ask judge` consolidates what they found, merging the same
  observation stated three ways and recording who raised it.
- `review_ask critique` puts the judge's conclusions back to the
  roster for pushback, recording positions rather than findings.

A judge with no council to read is refused rather than asked to invent
findings, and a critique with nothing consolidated is refused the same
way. Stopping after the council is perfectly reasonable; the later
rounds cost real money and earn their keep on a change where the
findings disagree with each other.

**A position is not a finding.** A critique tells you which findings
survived scrutiny and which a reviewer thinks are wrong, and
`disagree` from a model that went and read the code is worth more than
the finding it disputes. Silence means no position, never agreement,
so do not read an uncontested finding as a corroborated one.

## Putting Work Up

`review_offer propose` turns a branch into a change. From a checkout,
`review_offer propose draft:false` is usually the whole call: the head
comes from the branch you are on, the base from the repo's trunk, and
the title from the last commit's subject.

**The gate names everything it took from the checkout.** Read that line
rather than approving past it; it is there so a wrong guess is caught
by the one person who can tell. It also says when the tree has
uncommitted work in it, since what goes up is what was pushed.

Two things are never guessed. **`draft` is required**, because the
backends disagree about what silence means: one opens a new change
ready and another opens it as a draft, so a default makes the same call
produce a live change on one and an invisible one on the other. And a
**base** with no trunk to read is refused rather than assumed to be
`main`: a wrong head is obvious to whoever approves, while a wrong base
proposes against something nobody meant and asks the wrong team to look
at it.

Every action asks the provider before it asks the network, and a
refusal carries **what to do instead**. Pass that on rather than
reporting a generic failure: "retargeting is a stack operation here,
restack locally and submit the stack" is actionable, and "unsupported"
sends somebody to read a CLI's help.

The refusals you will actually meet:

- **Retargeting** is a change-level edit on some backends and a
  **stack** operation on others. Where it is a stack operation, moving
  one change means resubmitting the stack it sits in.
- **Reviewers** are settable any time on some backends and **only at
  creation** on others. Where they are creation-only, name them on the
  propose call; afterwards, ask people directly.
- **A change queued to merge** refuses mutation on a queue-backed
  backend, because touching it ejects it and everything speculatively
  batched with it, and re-running the checks for the rest is measured
  in hundreds of jobs. Merging is not a mutation the queue objects to.

On merging: pass `expectedHead` when you have it. It is the only guard
against merging work pushed since you last looked, and the gate says so
plainly when you leave it out. Leave `method` alone unless you mean to
override the repo's own policy.

## Findings You Fix Rather Than Say

A review produces two kinds of conclusion and only one is a remark. On
your own change, a finding you agree with is not something to post, it
is something to go and do. `review_draft decide settle:fix` puts it on
a queue instead of into the draft.

`fix-next` hands back one finding and stops. **Do the work in your own
loop**, where the person watching can interrupt with a sentence, then
`fix-done commit:...` records it. The commit is required: it is what
makes the claim checkable later against the history.

`fix-skip body:"why"` drops one, and the reason is required too. The
queue keeps skips rather than deleting them, because deciding a finding
was wrong is a judgement worth reading back, and a skip with no reason
reads the same as forgetting.

This is the shape of reviewing your own change before you ship: council,
judge, then `fix` every finding that holds and never publish anything.

## Publishing Across a Stack

`review_draft publish-stack` sends every draft in the stack, in the
order the stack applies. A draft is about one change, so a review of a
stack is several drafts, and publishing them by hand loses the only
thing worth knowing afterwards: which changes now carry a review.

Only changes that have a draft with something in it are published. A
stack of six where two drew remarks sends two reviews, not four empty
ones, and the answer names the changes it skipped.

**A failure on one change does not stop the others**, and the answer
names what is still unsent so publishing again sends only the
remainder. Report that plainly: a partly published stack that reads as
a total failure gets posted twice.

## Personas Are What Make Six Reviewers Worth Asking

A roster entry may name a `persona`, and the charter behind it becomes
that reviewer's system prompt. Without one, six reviewers are one
reviewer asked six times.

Charters are markdown files in `~/.config/pi/personas` (or
`$XDG_CONFIG_HOME/pi/personas`, or wherever `REVIEW_PERSONAS_DIR`
points). The file name is the persona id. Frontmatter carries `name`
and `description` and **no mechanism**: which model a lens runs on, how
hard it thinks and what tools it can reach live in the roster beside
the other participants, so the same lens at two thinking levels is two
roster entries rather than two nearly identical files. The body is the
charter.

**A persona named in the roster and missing on disk refuses the whole
round.** It does not quietly run a generic reviewer: that reviewer
would still file its findings under the specialist's name, and whoever
read them afterwards would weigh them as a specialist's.

## Reviewing a Stack as a Stack

`review_ask stack` puts every change in the stack to every reviewer
together. Reach for it when the changes only make sense as a sequence:
an interface introduced at the base and used wrongly at the tip, a
migration split so the middle change cannot deploy on its own. Those
findings are invisible to a per-change pass, because no single diff
contains them.

A finding names the changes it is about. One change for an ordinary
finding, several for a cross-change one, and a cross-change finding
stays **one** finding filed once at its **earliest** change. That is
where the decision was made and where a reader walking the stack meets
it first; filing it at the tip sends somebody to the consequence and
leaves them to work back to the cause.

Spans name refs, never positions. A stack renumbers itself whenever
somebody restacks it, so a finding recorded as "the second change"
becomes a finding about something else the moment anything lands
underneath.

It needs a provider that reads stacks, and it needs proposals: a stack
of branches nobody has proposed is still a stack, but it carries no
bodies or diffs to read. Both refusals say which.

## Auditing What Other People Asked For

`review_ask audit` is the one round that looks outward rather than at
the diff. A change under review usually arrives with threads on it,
some answered by later commits and never marked resolved, and working
out which is slow and easy to get wrong in both directions: replying
"fixed" to a thread nothing addressed reads as a brush-off, and
re-fixing something already fixed wastes a round trip.

It reports one of four standings per thread. `addressed`,
`outstanding`, `unclear`, and `elsewhere` for a thread another change
in the stack answers, which happens constantly and matters because
calling it addressed sends somebody looking in the wrong diff.

**It never posts and raises no findings.** These are other people's
words; turning them into findings would put them in the review as
yours. Use it to inform a `review_say reply`, and keep the reply your
own decision.

An id that has raised findings is held to the model, thinking level,
tools and persona it meant. Reconfiguring one mid-session is refused,
because every origin recorded before the change would quietly start
lying. The refusal names both ways out, and `review_ask release` is
the second one: it frees the id at the cost of its existing findings
no longer identifying who raised them.

The roster lives in a `review.ask` section of the package config, not
in the call, because who reviews is a standing choice. A malformed one
is refused with the path inside it that is wrong.

Participants read a snapshot pinned to the commit under review, so a
change that is not checked out where you are is still reviewed against
its own code. When no working layer is loaded, or the provider cannot
say which commit is under review, the round runs against your own tree
and says so in its answer. **Pass that caveat on.** A round that read
the wrong tree still returns plausible findings, and the caveat is the
only thing that distinguishes them.

A round also survives its participants failing. `review_ask runs`
reports how many of them answered, so read that rather than assuming
six reviewers means six opinions. `review_ask retry participant:"id"`
asks one of them again and substitutes the outcome in place, keeping
the rest of the round.

## Attach the Change, Then Stop Naming It

`review attach` binds the change you are working on, and
every later call can leave it out. This is the difference
between reading a change and reciting its number six times,
and the recitation is where the typos live.

```
review attach change:2000970
review_see diff
review_see threads
review_say reply thread:3 body:"..."
```

The rule when a call names nothing is always the same: one
attached change is used and said out loud, several are
listed rather than guessed between, and a change you name
explicitly is never second-guessed. Acting on the wrong
change is worse than being asked which one.

`review next` and `review prev` move the attachment along
the stack, which is how to walk a stack without naming each
member. A node that forks reports both children instead of
choosing, for the same reason.

Note that stepping the attachment moves nothing on disk. It
changes which change the tools talk about, not which branch
is checked out anywhere.

## A Finding Is Not Yet a Remark

A finding is something a review pass raised. Nobody has seen it
but you. A remark is something you have decided to say. Keeping
those apart is the whole point of the findings surface:

```
review_see findings              what was raised, numbered [F#]
review_draft decide finding:3 settle:"promote"
review_draft decide finding:4 settle:"dismiss"
review_draft plan                what publishing would do
```

Promoting copies the finding into the draft as a remark, taking
its own words unless you supply better ones. Dismissing drops it
and says so. Nothing reaches the change until the draft is
published, so a finding you never decide is a finding nobody
ever reads.

Finding numbers climb and are never reused, even after the list
is cleared, because people refer to findings by number out loud
and a recycled number makes an earlier conversation wrong.

## Never Assume GitHub

The provider is resolved from configuration, then from
provider claims, then from the shapes the user has mapped.
A reference is a URL, an `owner/repo#number` short form, or
a bare number inside a checkout.

This matters most when it is invisible. A checkout can carry
remotes pointing at two different systems, one of them a
read-only mirror, and a review posted to the mirror succeeds
and is read by nobody. Say which provider answered when it
is relevant, and never report a generic failure when you can
name the provider that was asked.

Ask `review capabilities` when you need to know what a
provider can do before offering it. It leads with which
provider is holding the change, because "who handles this"
and "what can be done to it" are the same question asked
twice. A facet that is absent is absent on purpose: it means
the provider cannot do that thing, not that it forgot to say
so.

## A Change Nobody Has Proposed Is Still a Change

Pass `base` and `head` for a range, or `refs` for a stack of
branches. Nothing needs to host it. This is how to review
work before it is proposed, or work that will never be
proposed at all.

Where nothing hosts the target, `review_draft render` writes
the review as a document rather than failing. Reach for that
instead of reporting that publishing is impossible.

## Read Provenance Before Trusting a Stack

Every stack says where its shape came from.

- `authoritative` means the server recorded the parentage.
  Act on it.
- `derived` means it was inferred from base and head names,
  and it is wrong at the edges: a merged parent or a renamed
  branch ends the chain early.

Pass that caveat on when it changes the answer. A derived
stack presented as fact is the failure this field exists to
prevent.

## Compose, Then Plan, Then Publish

Build a review up in a draft rather than posting remark by
remark. A draft persists, so a review can span a session and
be picked back up by id.

1. `review_draft open` on the change.
2. `finding` for each remark, `reply` into existing threads,
   `resolve`, `react`, `verdict` for the position.
3. `plan` to see exactly what publishing will do.
4. `publish`.

**Always plan before publishing, and say what will degrade
before the user finds out from the result.** The plan names
what will land where it was aimed, what will land somewhere
else and why, and what cannot land at all. A remark whose
anchor is not in the diff spills into the body; a batch too
large for the server is refused up front.

Publishing keeps whatever did not land, so a retry sends
only the remainder. Say so when something fails, rather than
letting a second attempt look like it duplicated the first.

## Threads Are Named by Index

Refer to a thread by the `[T#]` index the threads listing
shows. Never invent or guess a thread id: the backends key
them differently, and one keys a reply by the comment that
started the exchange rather than by the thread.

## Every Write Asks First

Anything that changes somebody else's change opens a
confirmation gate. Describe what you are about to post
before calling it, so the gate confirms a decision the user
already understands rather than presenting them with one.

Without a UI the gate approves, so a tool running inside a
subagent has nobody to ask. Do not rely on the gate as the
only thing standing between a draft and a stranger's change.

## Reads Degrade, Writes Refuse

A read that loses part of its answer reports the part it
lost and returns the rest. A write that cannot be performed
correctly refuses rather than performing something close.

Follow the same rule in what you say. "Thirty-four threads,
and who resolved them could not be read" is useful. "Thirty
four threads" when the resolvers were silently dropped is
not.
