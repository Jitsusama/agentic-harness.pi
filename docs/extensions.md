# Extension and Skill Categories

What each extension and skill suffix commits to, and why the
extensions that need a reason are there. [AGENTS.md](../AGENTS.md)
keeps the one-line version of each category.

## Extension Categories

Every extension has a contract suffix that identifies what
it does:

- **Guardians** (`*-guardian`): intercept shell commands and
  present them for human review, inline or in a gate as the
  guard policy says. Implement `CommandGuardian<T>` with
  detect → parse → review.
  `commit-guardian`, `pr-guardian`, `issue-guardian`,
  `history-guardian`

- **Interceptors** (`*-interceptor`): intercept shell commands
  and modify or block them silently, without a review gate.
  `attribution-interceptor`, `edit-escape-interceptor`,
  `git-cli-interceptor`, `github-cli-interceptor`

- **Workflows** (`*-workflow`): orchestrate a multi-step or
  session-wide process with state and stages. This covers
  persistent session workflows such as planning.
  `quest-workflow`,
  `ask-workflow`, `away-workflow`, `guard-policy-workflow`,
  `result-store-workflow`,
  `cost-workflow`, `image-budget-workflow`,
  `panel-lifecycle-workflow`, `job-workflow`,
  `session-recall-workflow`, `install-check-workflow`,
  `reload-workflow`, `rollover-workflow`, `shell-workflow`,
  `mesh-workflow`, `priority-workflow`, `stray-output-workflow`.

  `stray-output-workflow` keeps writes off pi's screen while its TUI
  holds the terminal. pi guards neither stream in interactive mode, and
  its own event bus `console.error`s a throwing `pi.events` handler's
  whole stack over the editor. Each caught write is kept with the stack
  that made it, and the person sees one line naming the writer, so a
  handler that throws can be found rather than only seen.

  `priority-workflow` keeps pi ahead of the work it starts: where
  the machine names an idle cgroup for work in `JOBS_CGROUP`, every
  process pi spawns is written into it as it is spawned, and pi
  stays where it was started.

  `away-workflow` makes the person being away a mode rather than a
  convention the model has to remember: blocking approvals hold
  their call, `ask` takes its recommendation, and a run that ends
  without `Done:` or `Blocked:` is sent back through job-workflow.
  Its state is `lib/internal/away/`, read by the gates without
  importing the extension. It errs towards stopping: nothing held
  is ever approved on the person's behalf, and the nudging has
  bounds of its own.

  `install-check-workflow` says when the code running is not
  the code on disk: a dependency installed outside its range in
  `package.json`, a checkout behind its upstream, or a HEAD that
  moved since the code loaded. A pull is neither a reinstall
  nor a reload, and both used to drift silently for days.

  `reload-workflow` lets the agent reload its own session, onto
  the worktree it is changing, and carry on when the reload
  lands, so trying a change needs neither a merge nor a person.
  The `reload` tool only asks: pi gives `reload()` to a
  command's context alone, so the request is handed to
  `/harness reload` once the run settles. A tree is loaded in a
  pi of its own first, and the install's settings entry points
  at it only for the reload itself, since a tree beside the
  install would load twice.

  `rollover-workflow` moves a session whose log has passed 64 MB
  into a fresh log at the first still moment after a compaction,
  keeping what the model sees and every extension's state, with
  the old log as its parent: pi holds a whole log in memory for
  the life of a session. `session_recall` reads the parents back
  from disk. Like reload, the switch is a command's alone, so it
  goes through `/rollover`.

  `job-workflow` hosts background jobs. A tool that returns
  before its work ends hands the work to it, and it says the
  result to the model as a prompt of its own once no run,
  compaction or submitted prompt is under way, since a message
  queued behind a run is what Escape puts in the person's
  editor. It is the only thing that starts a turn nobody
  typed, so every producer goes through it.

  `shell-workflow` replaces pi's `bash` with pi's own definition,
  rebuilt with the same settings, and adds two things: the
  agent's commands get no editor or pager to wait on, and a
  command still running after a minute moves to a job
  instead of holding the session. It hands off rather than
  kills, because the session logs show short timeouts killing
  real builds. A codemode script's calls never move, since the
  script reads their structured result.

  `image-budget-workflow` scales images down at the
  `tool_result` seam, on the one ground that makes a silent
  reduction defensible: a provider bills an image by its
  dimensions, and the pixels above a display's logical
  resolution are redundancy rather than information.

  `cost-workflow` is the only extension here that reasons about
  money, deliberately: cost counted by whoever needed it
  produced five wrong answers in a row. It derives spend from
  the session logs pi already writes, so there is one writer of
  the truth and the ledger can be rebuilt whenever its shape
  changes. Anything else that learns a cost should emit to it
  rather than keep a second figure.

- **Integrations** (`*-integration`): bridge to external
  services via registered tools.
  `google-workspace-integration`, `web-search-integration`,
  `browser-integration`, `review-integration`,
  `work-integration`

  The last two are worth a note, because they bridge to
  whatever hosts a change rather than to one named service.
  `review-integration` hosts the six review tools over
  `agentic-harness.core`'s `review`, and every provider behind
  them registers over the event bus, so the extension has no
  idea which backends exist. `work-integration` does the same
  for `agentic-harness.core`'s `work` and
  the trees underneath. Neither imports the other: the review
  side reaches the working layer over the bus, so a consumer
  needs the work *library* and never the work *extension*.

- **Widgets** (`*-widget`): add UI elements to the interface.
  `content-viewer-widget`, `status-line-widget`,
  `panel-zoom-widget`, `claude-plan-widget`

- **Providers** (`*-provider`): contribute an implementation to
  a host over the `pi.events` bus without importing the host's
  registry: a `FrontEndProvider` decorating a subset of an MCP
  server's tools (shape, render or wrap), or a
  `CompactionProvider` writing summaries for
  `compaction-workflow`, which walks its providers as a chain,
  or summary contributions appended to what they write, as
  `compaction-selection-provider` quotes the paragraphs a
  compaction drops. Distinct from a `*-widget`, which adds standalone UI, and from
  an `*-integration`, which hosts a service. The seam is the
  bus, so a provider can live in a different package from its
  host.

- **Packs** (`packs/`): an extension loaded into a subagent
  with `pi --extension <path>` and never auto-discovered, so
  one must not live under `extensions/`: a directory pi scans
  is the wrong place for a thing pi must not load. A pack's
  tool belongs to the subagent, not to the session that
  dispatched one.

  `packs/review-journal` ships one, so a reviewer can write a
  finding down the moment it has one rather than saving every
  finding for an answer an interruption then takes. It is
  offered only for the finding-shaped rounds.

  A verifier is the other kind, a tool a subagent calls to
  validate its structured output against a schema before
  finishing. None ship; the `subagent` tool's `verify` option
  is how a caller attaches one.

  Note what the review rounds deliberately do not do. They
  attach a contract skill without a verify tool, so a
  malformed entry is dropped and warned about rather than
  refused, and a reviewer that half-follows the contract
  still contributes what it got right. The journal keeps that
  bargain: it writes down whatever shape it is handed and
  lets the round judge it, because a tool arguing with a
  reviewer about a missing field spends the budget the
  reviewer needed for the review.

## Skill Categories

Every skill has a type suffix that identifies what kind of
guidance it provides:

- **Guides** (`*-guide`): teach how to do something.
  Step-by-step instructions, principles, decision criteria.
- **Conventions** (`*-convention`): operational rules for
  using a tool.
- **Formats** (`*-format`): structural templates for
  artifacts.
- **Standards** (`*-standard`): opinionated quality and style
  preferences.

Skill names follow `{domain}-{concern}-{suffix}`. See the
`taxonomy-guide` skill in `.pi/skills/` for the full naming
rules, domain definitions and decision framework.

Extensions and skills are complementary. Skills teach
methodology; extensions enforce it. Some are paired (e.g.,
the `planning-guide` skill + `quest-workflow` extension) but
they all work independently.
