# Internal Library

Shared code used by extensions in this package. Not part of
the public library surface; don't import from here in
external packages. These modules may change without notice.

- **`git/`** — process-global bypass state for git command
  interception. Read by interceptors and guardians so
  approved commands skip re-gating.
- **`github/`** — GitHub utilities: CLI parsing, diff
  parsing, GraphQL helpers, PR reference resolution and
  review posting.
- **`guardian/`** — guardian-specific helpers that aren't
  part of the public `lib/guardian/` contract: commit
  message parsing and the entity review gate used by
  `commit-guardian`.
- **`package-state-dir.ts`** — resolve the on-disk state
  directory for one extension in this package. Honours
  `XDG_STATE_HOME`; scopes everything under
  `pi/agentic-harness.pi/<extension>/` so multiple pi
  packages on the same machine don't collide.
- **`pr-workflow-verify/`** — shared validator, semantic
  check helpers, stage contracts and the registration
  helper used by the five `pr-workflow-{stage}-verify`
  sibling extensions. Stage contracts pair a schema with a
  stage-specific item counter and semantic checks; the
  validator is pure and parameterised so the same engine
  drives every stage.
- **`state.ts`** — session state helpers: entry persistence,
  plan directory resolution and context filtering.
