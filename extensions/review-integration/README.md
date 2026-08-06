# Review Integration

Hosts the [review substrate](../../lib/review/) for a session:
owns the provider registry, registers the providers this package
ships, and exposes reviewing as tools rather than as shell
commands.

## The Tools

| Tool | For |
|---|---|
| `review` | What the session is working on: attach, detach, next, prev, capabilities |
| `review_see` | Every read: change, diff, checks, stack, changes, threads, reviews, messages |
| `review_say` | Saying something now: reply, comment, resolve, unresolve, react |
| `review_ask` | Putting the change to other models: council, start, judge, critique, audit, stack, runs, collect, retry, release |
| `review_offer` | Putting work up and moving it along: propose, edit, ready, draft, reviewers, close, reopen, merge |
| `review_draft` | Composing a review, seeing what publishing would do, then publishing or rendering it, and holding the findings you decided to fix rather than say |

Split by intent rather than by subject. The subject is nearly
always the change, so a subject-shaped split (`review_stack`,
`review_thread`) only asked the caller to guess which noun owned
which question. What actually varies is whether you are reading,
saying something now, or composing something to say later.

One tool per intent rather than one per verb. Twenty-five tools
would crowd out everything else in a session; one tool with
twenty-five actions is unreadable in a registry listing.

`review_offer` is the sixth, and the one that makes the set an
arc rather than a reading surface: it puts a branch up as a
change and moves it along to a merge. It asks the provider
whether an intent is possible before it asks the network,
because authoring has no graceful degradation the way an
unanchorable comment does.

## Every Write Asks First

Anything that changes someone else's change opens a confirmation
gate showing what is about to happen. This is what lets the
authoring flows eventually stop leaning on the shell guardians:
the gate lives where the action is, instead of downstream of a
command line that has to be parsed back into intent.

Without a UI the gate approves. A tool running inside a subagent
has nobody to ask.

One renderer draws all of them, in four parts and a fixed order,
so the shape is learned once: where this is going, what it is
answering, what is being sent, and what follows. The payload is
never clipped, because it is the one thing the gate exists to
show, and it is drawn as markdown, because a review body is
written as markdown and every other gate in the package renders
its own that way. Quoted context is clipped, one remark at a
time rather than across the exchange, so a long opening cannot
push the reply that prompted all this off the bottom.

The panel wears the same nameplate as its neighbours: a Title
Case phrase naming the act, no question mark, since the panel is
already a question and its footer says so. A batch opens each
tab by saying which of how many it is. Both are held by
`tests/package/gate-titles-read-alike.test.ts`, which exists
because the review gates went out looking like a different
application and no test could tell.

A gate can be argued with. `Shift+Escape` redirects and
`Shift+r` annotates a rejection, and both come back as a refusal
carrying what was said, for the model to read as an instruction.
A bare rejection keeps the tool's own wording, because the
person said no and nothing else.

## One Gate Per Intent

A gate interrupts once per human intent, never once per request,
and only when it can show something the transcript could not.

Answering a thread and closing it is one intent, so `reply`
carries `settleThread` and costs one call. Answering five is one
intent too, so `items` takes them all and opens one gate with a
tab each. A tab nobody touched is sent when the panel is
submitted, which diverges from the Slack gate deliberately: the
items were composed in one breath and are all on screen, so the
keypresses being saved decide nothing. A tab explicitly rejected
stays rejected, and a redirect anywhere abandons the batch,
since steering one item means composing them again.

## Publishing Is Planned Out Loud

`review_draft plan` narrates what will happen before anything is
sent: which requests will run, which items will land somewhere
other than where they were aimed and why, and which cannot land
at all. Degradation announced up front is a decision;
degradation discovered from a rejected request is a surprise.

`publish` keeps whatever failed in the draft, so a retry sends
the remainder rather than duplicating what already landed.

The gate itself gives every operation a tab and shows each
payload whole, with the plan leading. Rejecting a tab drops the
draft items behind it and the plan is compiled again without
them, so the gate is the last chance to drop a remark rather
than something you run `drop` for beforehand and then cannot see
what you dropped. Remarks are shown against the code they point
at, from the diff already fetched to judge degradation.

## Configuration

The `review` section of
`~/.config/pi/agentic-harness.pi/config.json`:

```json
{
  "sections": {
    "review": {
      "repos": [
        { "match": "shop/world", "providers": ["meteorite", "github"] }
      ],
      "references": [
        {
          "pattern": "^cr/(?<repo>[^/]+)/(?<id>\\d+)$",
          "provider": "meteorite"
        }
      ]
    }
  }
}
```

`repos` pins a repo to providers in preference order, skipping
any that are not registered, which makes a mapping safe to write
before the provider ships. `references` teaches the substrate a
URL or short form no provider recognizes. Neither is required,
and nothing defaults: an unrecognized reference comes back as a
refusal naming the knob that would fix it.

### What Bounds a Reviewer

The `ask` subsection holds three durations, in milliseconds, and
they answer three different questions:

| Key | Default | What it decides |
|---|---|---|
| `backstopMs` | 45 min | When a reviewer is stopped regardless |
| `idleMs` | 15 min | How long it may say nothing before it is wedged |
| `answerMs` | 5 min | How much of the backstop is kept back for its answer |

Only `idleMs` is a liveness guard. `backstopMs` is a last resort
for a reviewer nothing else will stop, and using a wall clock to
answer the liveness question is what killed working reviewers in
six consecutive rounds.

`answerMs` is the one that is not a limit. It is carved out of
`backstopMs` rather than added to it, so a reviewer with the
defaults investigates for forty minutes and is then asked, with
five minutes in hand, for what it has. Whatever is reserved is
what the wrap-up is allowed, so raising it buys a longer answer
and costs the same amount of investigation.

Zero switches it off: a reviewer then runs to the wall and is
asked afterwards, on time nobody budgeted, which is what this
did before the reserve existed. It is the only clock here where
zero is honoured rather than read as a typo, because for the
other two a zero would stop every reviewer the instant it
started.

A reserve at least half the backstop is ignored rather than
honoured, since a reviewer asked to wrap up before it has read
anything has nothing to wrap up.

## Registering a Provider

A provider registers over the event bus, so it can live in
another package entirely:

```ts
import {
  REVIEW_READY,
  REVIEW_REGISTER_PROVIDER,
} from "agentic-harness.pi/lib/review";

// Both directions, so load order does not matter.
pi.events.on(REVIEW_READY, () => {
  pi.events.emit(REVIEW_REGISTER_PROVIDER, myProvider);
});
pi.events.emit(REVIEW_REGISTER_PROVIDER, myProvider);
```

A provider that specializes in one repo should claim at a lower
priority number than the generalist it needs to beat.

## Using the Substrate From Another Extension

A consumer needs the same two directions, for the opposite
reason. The bus does not replay, so an extension that loaded
after this one missed the announcement and cannot tell that it
happened. Asking is how it catches up:

```ts
import {
  REVIEW_READY,
  REVIEW_REQUEST_SUBSTRATE,
  type ReviewSubstrateApi,
} from "agentic-harness.pi/lib/review";

let substrate: ReviewSubstrateApi | undefined;

pi.events.on(REVIEW_READY, (api) => {
  substrate = api as ReviewSubstrateApi;
});
// In case the host was already up when we loaded.
pi.events.emit(REVIEW_REQUEST_SUBSTRATE, undefined);
```

Take the engine from the api rather than building one. A private
engine sees only the providers it registered itself, so a
provider that arrived over the bus would be invisible to it, and
that provider is usually the whole reason the consumer cares.

```ts
const engine = await substrate.engine();
const bound = await engine.resolve("Shopify/world#2000970");
const threads = await bound.conversation?.threads(bound.target.change);
```

## Joy

The renderings use one glyph per concept, always the same one,
so the eye learns a vocabulary rather than decoding a new rebus
each time: 🌐 target, 🪜 stack, 🧵 thread, 📌 finding, 🎭
verdict, ✨ lands, 🌥 lands differently, 🚧 will not land, 📜
document.

None of them reach a forge. What gets posted is someone else's
surface.
