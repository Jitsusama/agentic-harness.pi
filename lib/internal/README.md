# Internal Library

Shared code used by extensions in this package. Not part of
the public library surface; don't import from here in
external packages. These modules may change without notice.

- **`guardian/`** — guardian pipeline: `CommandGuardian`
  interface, registration helper, shell parsing and entity
  review gate.
- **`github/`** — GitHub utilities: CLI parsing, diff parsing,
  GraphQL helpers, PR reference resolution and review posting.
- **`state.ts`** — session state helpers: entry persistence,
  plan directory resolution and context filtering.
