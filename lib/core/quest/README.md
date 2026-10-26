# Core's Quest Workflow

The parts of the quest workflow that core kept and the harness's
`lib/quest` doesn't: the stage machine, runtime state, the package
configuration's quest section, the verb registry, the lifecycle
mutations, the read-only lookups and the rows they render, and the
verbs in `verbs/`. They read and write quests through the harness's
`lib/quest` and `lib/internal/quest`, which are the only copies of
the quest store's types, parsing and I/O.

The quest tool's alias, reorder and structural verbs live in `verbs/`,
and `extensions/quest-workflow/verbs` re-exports them beside the verbs
only pi runs: create, load, show, the queries and the session story.
