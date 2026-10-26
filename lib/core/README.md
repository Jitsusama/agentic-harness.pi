# Core

The code of [agentic-harness.core][core], folded into the harness at
core's commit `9c5764b` (version 0.16.3), so that one package holds
the harness and a change to a quest verb is one change in one
repository. Joel, 2026-10-25: "i would be glad to get rid of the ass
claude code repo and the need for a core".

Each folder is one of core's modules, laid out as core had it, and
each module's `index.ts` is what core exported as
`@jitsusama/agentic-harness.core/<module>`. The code is core's as it
was, but for its imports, which name their `.ts` files as the rest
of this package does.

What comes next, by the fold's plan (PLAN-20261025-QR647O):

- core's tests come across, beside the harness's own;
- each module that also has an older copy elsewhere in `lib/` loses
  one of the two, a domain at a time;
- a module that belongs beside the harness's own moves there, and
  this folder empties.

[core]: https://github.com/Jitsusama/agentic-harness.core
