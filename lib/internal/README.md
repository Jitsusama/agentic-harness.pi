# Internal Library

Shared code used by extensions in this package. Not part of
the public library surface; don't import from here in
external packages. These modules may change without notice.

- **`github/`**: GitHub utilities, being CLI parsing, diff
  parsing, GraphQL helpers, PR reference resolution and
  review posting.
- **`guardian/`**: guardian-specific helpers that aren't
  part of the public `lib/guardian/` contract: commit
  message parsing, the entity review gate used by the
  commit, PR and issue guardians, the last-outcome registry
  `/guards` reads, and `guards.ts`, the catalogue every
  guard in this package is declared from.
- **`package-state-dir.ts`**: resolve the on-disk state
  directory for one extension in this package. Honours
  `XDG_STATE_HOME`; scopes everything under
  `pi/agentic-harness.pi/<extension>/` so multiple pi
  packages on the same machine don't collide.
- **`state.ts`**: session state helpers, being entry persistence,
  plan directory resolution and context filtering.
