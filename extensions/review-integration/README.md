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
| `review_ask` | Putting the change to other models: council, judge, critique, audit, stack, runs, retry, release |
| `review_draft` | Composing a review, seeing what publishing would do, then publishing or rendering it |

Split by intent rather than by subject. The subject is nearly
always the change, so a subject-shaped split (`review_stack`,
`review_thread`) only asked the caller to guess which noun owned
which question. What actually varies is whether you are reading,
saying something now, or composing something to say later.

One tool per intent rather than one per verb. Twenty-five tools
would crowd out everything else in a session; one tool with
twenty-five actions is unreadable in a registry listing.

`review_author` joins them when the authoring facet is
implemented.

## Every Write Asks First

Anything that changes someone else's change opens a confirmation
gate showing what is about to happen. This is what lets the
authoring flows eventually stop leaning on the shell guardians:
the gate lives where the action is, instead of downstream of a
command line that has to be parsed back into intent.

Without a UI the gate approves, matching the pr-workflow gates.
A tool running inside a subagent has nobody to ask.

## Publishing Is Planned Out Loud

`review_draft plan` narrates what will happen before anything is
sent: which requests will run, which items will land somewhere
other than where they were aimed and why, and which cannot land
at all. Degradation announced up front is a decision;
degradation discovered from a rejected request is a surprise.

`publish` keeps whatever failed in the draft, so a retry sends
the remainder rather than duplicating what already landed.

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
