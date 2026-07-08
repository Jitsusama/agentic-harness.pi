# memory-integration

Durable, quest-scoped memory so the agent stops re-onboarding
every session. Retain a fact once, and it comes back the next
time you resume the quest.

## What it does

- Four tools, no slash command: `memory_retain` stores a
  durable fact scoped to the loaded quest (or the project);
  `memory_recall` retrieves facts, optionally filtered by a
  keyword; `memory_reflect` synthesizes an answer over them;
  `memory_edit` amends or invalidates a fact.
- A prompt contributor rehydrates the active scope's facts
  into the resident system prompt through the coordinator, so
  resuming a quest brings its facts back automatically. Because
  the resident block is frozen per session, a mid-session
  retain does not change it; the agent reaches new facts
  through `memory_recall`.
- When a quest concludes or retires, its scoped facts are
  archived, so memory ages out with the work that produced it.

## Retention is by lifecycle, not age

A true fact never expires and is never silently evicted for
being old. Memory is bounded three other ways: scope lifecycle
(quest facts archived on conclusion), explicit invalidation,
and a soft per-scope cap that surfaces the weakest facts for
curation rather than deleting them.

## Design

The store, scope resolution and lifecycle logic live in
`lib/memory` over SQLite, in the memory store's own database
file, separate from the observability table. This extension
caches the store handle for the session and wires the tools,
the recall contributor and the conclude hook.
