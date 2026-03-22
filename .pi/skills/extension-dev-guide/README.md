# Extension Development

Guidance for developing Pi extensions. Currently covers TUI
component discovery and usage; it'll grow to cover other
extension development concerns.

Rather than duplicating Pi's API docs (which go stale on every
update), this skill teaches the agent **how to discover** what's
available by reading the live source of truth:

- Pi's `tui.md` and `extensions.md` for patterns and examples
- Type declarations (`.d.ts`) for exact APIs
- This project's `lib/ui/` for existing abstractions

It includes orientation tables (what component for what job)
and a gotchas section covering the non-obvious mistakes that
cause real bugs.
