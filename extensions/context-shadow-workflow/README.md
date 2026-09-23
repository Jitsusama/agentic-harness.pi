# Context Shadow Workflow

Measures what a demotion policy could reclaim from resident context on
every real call, and changes nothing about what is sent.

## Why bash and Why Shadow Mode

bash has no size tail at all: thirty thousand small results each paying
rent for the rest of a seven-hundred-turn session. A ceiling on any one
result cannot touch that, since there is no single large result to cap.
The only lever left is deciding, per call, which already resident
results still earn their rent, which is a decision, not a measurement,
and the plan this extension serves is explicit that no controller acts
before it has run in shadow mode first.

This is that shadow mode. It hooks pi's `context` event, which fires
with the exact messages about to be sent and can rewrite them without
touching stored session state, and asks `findReclaimable` which already
resident bash results fall outside a kept recent window. It then
publishes what it found on `context:reclaimable` and returns nothing,
which is what leaves the request exactly as pi assembled it.

## What Is Not Here Yet

Nobody currently listens on `context:reclaimable`. The event exists so a
future status reading or a durable record can subscribe to it, the same
way `cost-workflow` publishes `cost:reading` for the status line to lay
out. Persisting a running total, and deciding whether to ever act on
what this finds, are both separate, later steps.

## Files

- `index.ts`: registration and the `context` hook.

The analysis itself, `findReclaimable`, lives in `lib/context/`, since
it needs nothing from pi and is exercised directly by its own tests.
