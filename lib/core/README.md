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

Core's tests are under `tests/core/`, and move to `tests/lib/` with
their module. Modules that had a second copy elsewhere in `lib/`
keep one copy at the `lib/` path, a domain at a time: refs,
registry, thinking and ui, then gate, prose and clock, then shell,
command, guardian and memory, then google, slack, terminal,
completion and internal/process-global have gone from here.

What comes next, by the fold's plan (PLAN-20261025-QR647O):

- the quest modules with a second copy lose one of the two;
- a module that belongs beside the harness's own moves there, and
  this folder empties.

## Folders

- `advisor/`: the advisor's decision core: its charter, the
  read-only tools an investigation calls, its findings and whether
  a turn is worth reviewing. Wiring it to a live session is not
  here.
- `attribution/`: marking AI involvement in commits, PRs and
  issues: the commit hook, the `gh` body footer and the model's
  name as it is shown.
- `exec/`: running a command as a dependency rather than an
  import: the `Exec` type, its result and a spawning runner.
- `git-cli/`: the git commands blocked before a guardian sees
  them: an amend, an unquoted heredoc, a compound command.
- `github-cli/`: the `gh pr` and `gh issue` commands that break
  the github-cli-convention skill's form for bodies and metadata.
- `governance/`: the store of captured rules, distilling them from
  a transcript, and the rules block the prompt carries.
- `internal/`: what the modules here share and no barrel exports;
  its README says what each part is for.
- `lsp/`: code intelligence behind one backend contract, with a
  standalone backend that runs the language servers itself.
- `notes/`: the notes archive: a note's types and the verbs that
  make, change and find notes.
- `observability/`: run telemetry for subagents and councils in
  SQLite, and the ledger of the main loop's own turns.
- `process/`: asking the machine about a process, and whether it
  is still the one that was meant.
- `quest/`: the parts of the quest workflow core kept, such as the
  stage machine and the verbs; its README says how they sit beside
  `lib/quest`.
- `remote/`: naming a git remote to a person, without its
  credentials.
- `result/`: tool answers bounded without loss: the payload in a
  session store, a view and a digest of it, and a query to reach
  the rest.
- `review/`: reviewing code changes over one neutral model, with
  GitHub and bare git as providers.
- `sections/`: the sanctioned headings of PR and issue bodies, what
  each section may hold and say, a PR body composed from fields,
  and the section gate's decision.
- `session/`: conversation identity, slots, environment and ownership,
  preserving process behaviour on plain pi; its README defines the host contract.
- `title/`: finding conventional-commit prefixes in PR and issue
  titles, and the title gate's decision.
- `tree/`: the contract and registry of tree providers, and
  choosing one for a repo. The built-in git-worktree provider is
  in `internal/tree/`.
- `verify/`: running the project's check command on request, and
  saying whether it still builds and passes.
- `web/`: driving a real Chrome and reading back what it knows: the
  session, the page reader and search at the top, and a subdomain
  barrel a concern beside them, each imported by its own path.
- `work/`: the working layer: branches, commits, trees and stacks,
  with a broker that hands out trees and plain git as the provider
  that cuts them when nothing more specific does.

[core]: https://github.com/Jitsusama/agentic-harness.core
