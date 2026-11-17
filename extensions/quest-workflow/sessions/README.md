# Sessions

The quest workflow's live wiring for sessions, over the pure store in
`lib/internal/quest/sessions/session-registry.ts`. A running session's own
record over its life (opened, re-dated, handed over, ended) is
`../session-registry.ts`; what reads, repairs and reopens the records
of every session is here.

- `records.ts`: the records on disk, read, written, pruned, seeded
  for tabs open before the registry, and repaired when a probe finds
  a process gone.
- `signal-stamp.ts`: how a record learns that a terminal, the machine
  or a host took its session away rather than a quit.
- `restore.ts`: the sessions lost and worth offering back, and the
  launcher's restore file, carried and released sessions included.
- `reopen.ts`: reopening lost sessions and waiting for each to check
  in.
- `views.ts`: the sessions the quest tool lists: at work, recent, the
  start hint and those `show` lists.
- `membership.ts`: which quests a session belongs to, checked: the
  audit, the dead sessions and the repair plan.
