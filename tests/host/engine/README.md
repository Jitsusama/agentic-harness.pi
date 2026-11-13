# Engine Tests

Conversation ownership and isolation through the engine's public entry.
Fake cleanup callbacks stand in for pi runner disposal; no provider or live
host is started by these tests. tool-round-scrub.test.ts drives two
conversations' tool rounds directly, holding that a printed credential
is scrubbed from each streamed update and from the committed result.
parked-warming.test.ts warms a parked conversation's carry on fake
timers with a scripted send, over real files. quiet-collection.test.ts
holds the quiet collection to its rules on fake timers (none while a
tool call runs or a viewer typed in the last 30 s, one while a
conversation only waits on the model, none within 10 minutes of the
last but one a park brings forward), counts tool calls from session
events, and runs V8's own collection and reads this process's Pss.

hosted-agent.test.ts and engine.test.ts are the exceptions. The first runs
fixtures/hosted-session.mts in child node processes, beside pi's own agent,
on pi's scripted provider. The second runs fixtures/hosted-engine.mts, a
host's life one start at a time in a sealed folder: open, a refused key,
a stop and resume, a kill mid-tool and the start after it, ordinary
pi reading the file, and an extension whose link moves onto another
copy once its first is deleted, as a switch and a store collection
leave Shopify's proxy. One step loads this package as a conversation's
settings would: its tool list, deferred tools and pi's built-ins
included, and what its screen is handed to show at startup must equal a
plain pi's on the same folder. Both need a pi built with the host's
patches, found as tests/host/end-to-end/support/host-pi.ts finds it, so
an ordinary `pnpm test` skips each case, saying how to get one. They sit
in the process lane, since they spawn node from node. Run them before
merging a change to host/engine with `pnpm test:host`, which fails
rather than skips without that pi, or on one build:

```sh
PI_HOST_PACKAGE_DIR=<root> pnpm exec vitest run --project process \
  tests/host/engine/hosted-agent.test.ts tests/host/engine/engine.test.ts
```

The root is the pi-monorepo folder of a pi carrying every patch in
core.nix's modules/pi/pi-host-*.patch: the work host's piHostRuntime
(its lib/node_modules/pi-monorepo), or core's hostedPi, which the
pi-hosted-* checks build. host-pi.ts names any patch the pi lacks.

- `fixtures/`: programs a test runs in a node process of its own, and
  the probe extension the engine's fixture gives pi to load.
